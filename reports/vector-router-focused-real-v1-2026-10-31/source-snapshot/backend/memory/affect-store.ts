import { createHash } from 'node:crypto';
import { applyAffectSignal, createDailyAffect, snapshotAffect } from '../character/affect.js';
import { AFFECT_POLICY_VERSION, type AffectLearningUpdate, type AffectMood, type CharacterAffectState, type DailyAffectInput } from '../shared/affect.js';
import { AppError } from '../shared/types.js';
import type { Queryable, Row } from './database.js';

const INACTIVITY_MS = 24 * 60 * 60 * 1_000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function profileId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new AppError('invalid_affect_profile');
  return value.toLowerCase();
}

function date(value: unknown): string {
  // pg's DATE parser is configured to return strings. The Date fallback also
  // supports transaction adapters using pg's default local-midnight parser.
  const source = value instanceof Date
    ? `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : value;
  if (typeof source !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(source)) throw new AppError('invalid_affect_date');
  const calendar = new Date(source + 'T00:00:00.000Z');
  if (source.startsWith('0000-') || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== source) throw new AppError('invalid_affect_date');
  return source;
}

function timestamp(value: unknown): string {
  const source = value instanceof Date ? value.toISOString() : value;
  if (typeof source !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(source)
    || Number(source.slice(11, 13)) > 23 || Number(source.slice(14, 16)) > 59 || Number(source.slice(17, 19)) > 59) throw new AppError('invalid_affect_timestamp');
  date(source.slice(0, 10));
  const instant = Date.parse(source);
  if (!Number.isFinite(instant)) throw new AppError('invalid_affect_timestamp');
  return new Date(instant).toISOString();
}

function increment(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new AppError('invalid_affect_revision', 409);
  return revision + 1;
}

function assertState(state: CharacterAffectState): CharacterAffectState {
  // The policy validates finite vectors, supported policy/mood, timestamps, and
  // safe revisions. Its read-time snapshot has no side effects.
  try { snapshotAffect(state, state.updatedAt); }
  catch { throw new AppError('invalid_affect_state', 503); }
  return state;
}

function fromRow(row: Row): CharacterAffectState {
  if (row.policy_version !== AFFECT_POLICY_VERSION) throw new AppError('affect_policy_mismatch', 409);
  return assertState({
    policyVersion: AFFECT_POLICY_VERSION,
    localDate: date(row.local_date), dailyMood: row.daily_mood as AffectMood,
    baseline: { valence: Number(row.baseline_valence), energy: Number(row.baseline_energy) },
    conversation: { valence: Number(row.conversation_valence), energy: Number(row.conversation_energy) },
    updatedAt: timestamp(row.updated_at),
    lastInteractionAt: row.last_interaction_at === null ? null : timestamp(row.last_interaction_at),
    revision: Number(row.revision),
  });
}

async function cleanupReceipts(tx: Queryable, id: string, realNow: string): Promise<void> {
  await tx.query('DELETE FROM character_affect_receipts WHERE profile_id=$1 AND created_at <= $2',
    [id, new Date(Date.parse(realNow) - RECEIPT_RETENTION_MS).toISOString()]);
}

async function save(tx: Queryable, id: string, state: CharacterAffectState, realNow: string): Promise<void> {
  assertState(state);
  await tx.query(`UPDATE character_affect_state SET policy_version=$2,local_date=$3,daily_mood=$4,
    baseline_valence=$5,baseline_energy=$6,conversation_valence=$7,conversation_energy=$8,
    revision=$9,updated_at=$10,last_interaction_at=$11,updated_real_at=$12 WHERE profile_id=$1`,
  [id, state.policyVersion, state.localDate, state.dailyMood, state.baseline.valence, state.baseline.energy,
    state.conversation.valence, state.conversation.energy, state.revision, state.updatedAt, state.lastInteractionAt, realNow]);
}

function expired(state: CharacterAffectState, realNow: string): boolean {
  return state.lastInteractionAt !== null && Date.parse(realNow) - Date.parse(state.lastInteractionAt) >= INACTIVITY_MS;
}

function resetConversation(state: CharacterAffectState, effectiveNow: string): CharacterAffectState {
  return { ...state, baseline: { ...state.baseline }, conversation: { ...state.baseline },
    updatedAt: effectiveNow, lastInteractionAt: null, revision: increment(state.revision) };
}

/** Use within the existing memory transaction. It never changes growth/config. */
export async function ensureAffectState(tx: Queryable, input: DailyAffectInput, realNow: string): Promise<CharacterAffectState> {
  const id = profileId(input.profileId);
  const now = timestamp(realNow);
  const dailyInput = { ...input, profileId: id, localDate: date(input.localDate), effectiveNow: timestamp(input.effectiveNow) };
  let seed: CharacterAffectState;
  try { seed = createDailyAffect(dailyInput); }
  catch { throw new AppError('invalid_affect_input'); }
  let row = (await tx.query('SELECT * FROM character_affect_state WHERE profile_id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) {
    const inserted = await tx.query(`INSERT INTO character_affect_state(profile_id,policy_version,local_date,daily_mood,
      baseline_valence,baseline_energy,conversation_valence,conversation_energy,revision,updated_at,last_interaction_at,created_at,updated_real_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$11) ON CONFLICT(profile_id) DO NOTHING RETURNING *`,
    [id, seed.policyVersion, seed.localDate, seed.dailyMood, seed.baseline.valence, seed.baseline.energy,
      seed.conversation.valence, seed.conversation.energy, seed.revision, seed.updatedAt, now]);
    row = inserted.rows[0] ?? (await tx.query('SELECT * FROM character_affect_state WHERE profile_id=$1 FOR UPDATE', [id])).rows[0];
  }
  if (!row) throw new AppError('affect_state_not_found', 409);
  const savedDate = date(row.local_date);
  if (dailyInput.localDate < savedDate) throw new AppError('affect_day_mismatch', 409);
  let state: CharacterAffectState;
  if (savedDate !== dailyInput.localDate || row.policy_version !== AFFECT_POLICY_VERSION) {
    state = { ...seed, revision: increment(Number(row.revision)) };
    await save(tx, id, state, now);
  } else {
    state = fromRow(row);
    if (expired(state, now)) {
      // Reset only influence. Read-time exponential decay remains derived and
      // never writes a synthetic interaction or growth event.
      state = resetConversation(state, Date.parse(dailyInput.effectiveNow) < Date.parse(state.updatedAt) ? state.updatedAt : dailyInput.effectiveNow);
      await save(tx, id, state, now);
    }
  }
  await cleanupReceipts(tx, id, now);
  return state;
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function normalizedUpdate(update: AffectLearningUpdate): AffectLearningUpdate {
  if (!exactKeys(update, ['localDate', 'observedAt', 'signal']) || !exactKeys(update.signal, ['kind', 'target', 'strength'])
    || !exactKeys(update.signal.target, ['valence', 'energy'])
    || !['positive', 'calming', 'fatigue', 'engagement'].includes(update.signal.kind)
    || !Number.isFinite(update.signal.strength) || update.signal.strength < 0 || update.signal.strength > .35
    || !Number.isFinite(update.signal.target.valence) || update.signal.target.valence < -1 || update.signal.target.valence > 1
    || !Number.isFinite(update.signal.target.energy) || update.signal.target.energy < 0 || update.signal.target.energy > 1) throw new AppError('invalid_affect_update');
  return { localDate: date(update.localDate), observedAt: timestamp(update.observedAt),
    signal: { kind: update.signal.kind, target: { valence: update.signal.target.valence, energy: update.signal.target.energy }, strength: update.signal.strength } };
}

/** Completed delivery only; the caller holds its existing profile lock and
 * increments state_version once if ordinary learning or this update changed. */
export async function commitAffectUpdate(tx: Queryable, input: {
  profileId: string; turnId: string; update: AffectLearningUpdate; realNow: string;
}): Promise<{ applied: boolean; changed: boolean }> {
  const id = profileId(input.profileId);
  if (typeof input.turnId !== 'string' || !input.turnId.trim() || input.turnId.length > 200) throw new AppError('invalid_affect_turn');
  const now = timestamp(input.realNow);
  const update = normalizedUpdate(input.update);
  const row = (await tx.query('SELECT * FROM character_affect_state WHERE profile_id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw new AppError('affect_state_not_found', 409);
  let state = fromRow(row);
  if (update.localDate !== state.localDate) throw new AppError('affect_day_mismatch', 409);
  const turnHash = createHash('sha256').update(JSON.stringify([id, input.turnId])).digest('hex');
  const payloadHash = createHash('sha256').update(JSON.stringify({ policyVersion: AFFECT_POLICY_VERSION, ...update })).digest('hex');
  await cleanupReceipts(tx, id, now);
  const old = (await tx.query('SELECT payload_hash FROM character_affect_receipts WHERE profile_id=$1 AND turn_hash=$2', [id, turnHash])).rows[0];
  if (old) {
    if (old.payload_hash !== payloadHash) throw new AppError('idempotency_conflict', 409);
    if (expired(state, now)) {
      // A retry cannot refresh its old signal, but must not retain expired
      // influence when the caller reaches this helper without a context read.
      await save(tx, id, resetConversation(state, state.updatedAt), now);
      return { applied: false, changed: true };
    }
    return { applied: false, changed: false };
  }
  if (Date.parse(update.observedAt) < Date.parse(state.updatedAt)) throw new AppError('stale_affect_update', 409);
  const before = JSON.stringify(state);
  if (expired(state, now)) state = resetConversation(state, update.observedAt);
  let next: CharacterAffectState;
  try { next = assertState(applyAffectSignal(state, update, now)); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('invalid_affect_update');
  }
  if (next.policyVersion !== state.policyVersion || next.localDate !== state.localDate || next.dailyMood !== state.dailyMood
    || next.baseline.valence !== state.baseline.valence || next.baseline.energy !== state.baseline.energy || next.revision < state.revision) throw new AppError('invalid_affect_transition', 503);
  const changed = JSON.stringify(next) !== before;
  if (changed) await save(tx, id, next, now);
  await tx.query(`INSERT INTO character_affect_receipts(profile_id,turn_hash,payload_hash,policy_version,local_date,created_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, turnHash, payloadHash, AFFECT_POLICY_VERSION, update.localDate, now]);
  return { applied: true, changed };
}

/** A committed forget always removes derived conversation influence and every
 * receipt; the independent daily seed and all personality settings stay intact. */
export async function resetAffectAfterForget(tx: Queryable, input: {
  profileId: string; effectiveNow: string; realNow: string;
}): Promise<void> {
  const id = profileId(input.profileId);
  const effectiveNow = timestamp(input.effectiveNow);
  const now = timestamp(input.realNow);
  const row = (await tx.query('SELECT * FROM character_affect_state WHERE profile_id=$1 FOR UPDATE', [id])).rows[0];
  if (row) {
    // SQL copies the saved baseline directly, including an older policy version.
    // Privacy reset must not require recomputing or interpreting that policy.
    const revision = increment(Number(row.revision));
    await tx.query(`UPDATE character_affect_state SET conversation_valence=baseline_valence,
      conversation_energy=baseline_energy,last_interaction_at=NULL,updated_at=$2,
      updated_real_at=$3,revision=$4 WHERE profile_id=$1`, [id, effectiveNow, now, revision]);
  }
  await tx.query('DELETE FROM character_affect_receipts WHERE profile_id=$1', [id]);
}
