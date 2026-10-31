import { createHash, randomUUID } from 'node:crypto';
import type {
  AgeBand, AssertionEvidence, ChildProfile, ClockState, DailyState, ForgetResult, LanguageMode, LearningInput,
  MemoryCandidate, MemoryContext, MiuConfig, NightJobResult, Personality, RecallHook, Role, StoryProgress,
} from '../shared/types.js';
import { AppError, PERSONALITIES } from '../shared/types.js';
import { createDatabase, migrate, type Database, type Queryable, type Row } from './database.js';
import { addDays, atLocalHour, dateDifference, localDate } from './clock.js';
import { authoredDay, storyAt, STORY } from './authored-life.js';
import { chooseStory, getStory } from '../stories/index.js';
import { isSafeProjection, normalized, validateCandidate } from './evidence.js';
import { assertionEvidence } from './assertions.js';
import { canonicalPreferenceKey, retiredNameHash } from './normalization.js';

export { createDatabase, migrate } from './database.js';
export { validateCandidate, isSafeProjection } from './evidence.js';
export { canonicalPreferenceKey, retiredNameHash } from './normalization.js';
export interface CreateProfileInput {
  demoKey: string; displayName: string; ageBand: AgeBand; languageMode: LanguageMode; timezone: string;
  personality?: Personality; role?: Role;
}
export interface StoreOptions { databaseUrl?: string; dataDir?: string; now?: () => Date; clockMode?: 'real' | 'demo' }
const RETENTION = 30 * 86_400_000;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const day = (value: unknown): string => iso(value).slice(0, 10);
const str = (value: unknown): string => String(value);

export async function createMemoryStore(options: StoreOptions = {}): Promise<MemoryStore> {
  const db = await createDatabase(options);
  await migrate(db);
  return new MemoryStore(db, options.now ?? (() => new Date()), options.clockMode ?? 'demo');
}

export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public readonly db: Database, private readonly now: () => Date, private readonly clockMode: 'real' | 'demo') {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async profile(tx: Queryable, profileId: string): Promise<Row> {
    const row = (await tx.query('SELECT * FROM profiles WHERE id=$1 FOR UPDATE', [profileId])).rows[0];
    if (!row) throw new AppError('profile_not_found', 404);
    return row;
  }
  private mapProfile(row: Row): ChildProfile {
    return { id: str(row.id), demoKey: str(row.demo_key), displayName: str(row.display_name), ageBand: row.age_band as AgeBand,
      languageMode: row.language_mode as LanguageMode, timezone: str(row.timezone), stateVersion: Number(row.state_version), deletionEpoch: Number(row.deletion_epoch) };
  }
  private async clock(tx: Queryable, profile: Row): Promise<ClockState> {
    const row = (await tx.query('SELECT * FROM demo_clocks WHERE profile_id=$1', [profile.id])).rows[0]!;
    const wall = this.now();
    const effective = row.mode === 'real' ? wall : new Date(Date.parse(iso(row.effective_anchor)) + Math.max(0, wall.getTime() - Date.parse(iso(row.wall_anchor))));
    return { mode: row.mode as ClockState['mode'], effectiveNow: effective.toISOString(), localDate: localDate(effective, str(profile.timezone)), timezone: str(profile.timezone), version: Number(row.version) };
  }
  private async record(tx: Queryable, profileId: string, kind: string, source: string, key: string,
    evidenceKind = 'child_reported', scope = 'reported_real', expires?: string): Promise<string> {
    const id = randomUUID();
    const now = this.now();
    await tx.query(`INSERT INTO memory_records(id,profile_id,kind,source_turn_id,candidate_key,evidence_kind,scope,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, profileId, kind, source, key, evidenceKind, scope, now.toISOString(), expires ?? new Date(now.getTime() + RETENTION).toISOString()]);
    return id;
  }
  private async depend(tx: Queryable, profileId: string, sourceId: string, derivedId: string): Promise<void> {
    await tx.query('INSERT INTO memory_dependencies(profile_id,source_id,derived_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [profileId, sourceId, derivedId]);
  }
  private async deleteClosure(tx: Queryable, profileId: string, roots: string[]): Promise<string[]> {
    if (!roots.length) return [];
    const deleted = await tx.query<{ id: string }>(`WITH RECURSIVE doomed(id) AS (
      SELECT id FROM memory_records WHERE profile_id=$1 AND id=ANY($2::uuid[])
      UNION SELECT d.derived_id FROM memory_dependencies d JOIN doomed s ON d.source_id=s.id WHERE d.profile_id=$1
    ) DELETE FROM memory_records WHERE profile_id=$1 AND id IN (SELECT id FROM doomed) RETURNING id`, [profileId, roots]);
    return deleted.rows.map((row) => row.id);
  }
  private async purge(tx: Queryable, profileId: string): Promise<void> {
    const expired = await tx.query<{ id: string; personal: boolean }>(`SELECT r.id,
      (r.kind <> 'diary' OR EXISTS(SELECT 1 FROM memory_dependencies d
        WHERE d.profile_id=r.profile_id AND (d.source_id=r.id OR d.derived_id=r.id))) personal
      FROM memory_records r WHERE r.profile_id=$1 AND r.expires_at <= $2`, [profileId, this.now().toISOString()]);
    await this.deleteClosure(tx, profileId, expired.rows.map((row) => row.id));
    const expiredCorrections = await tx.query('DELETE FROM memory_operation_receipts WHERE profile_id=$1 AND created_at <= $2 RETURNING previous_name_hash', [profileId, new Date(this.now().getTime() - RETENTION).toISOString()]);
    // Expiry is a revocation, just like forgetting. Previously captured plans and
    // learning projections must lose authority even if no narrative date changed.
    // Independent authored diaries carry no child data and need no invalidation.
    if (expired.rows.some((row) => row.personal) || expiredCorrections.rows.some(row => row.previous_name_hash !== null)) {
      await tx.query('UPDATE profiles SET deletion_epoch=deletion_epoch+1,state_version=state_version+1 WHERE id=$1', [profileId]);
    }
    await tx.query('DELETE FROM turn_learning WHERE profile_id=$1 AND completed_at < $2', [profileId, new Date(this.now().getTime() - 7 * 86_400_000).toISOString()]);
    await tx.query('DELETE FROM clock_requests WHERE profile_id=$1 AND created_at < $2', [profileId, new Date(this.now().getTime() - 7 * 86_400_000).toISOString()]);
  }
  async createProfile(input: CreateProfileInput): Promise<ChildProfile> {
    // Future authenticated registration can use this same profile-creation path.
    // Assignment is durable configuration, selected only for a newly created profile.
    return this.serial(() => this.db.transaction(async (tx) => {
      if (!/^[a-z0-9_-]{1,64}$/i.test(input.demoKey) || !isSafeProjection(input.displayName) || input.displayName.length > 80 || !['4-5', '6-8'].includes(input.ageBand) || !['vi', 'en', 'follow_child'].includes(input.languageMode)) throw new AppError('invalid_profile');
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(this.now()); } catch { throw new AppError('invalid_timezone'); }
      if (!PERSONALITIES.includes(input.personality ?? 'ENFP') || !['friend', 'big_sibling', 'teacher'].includes(input.role ?? 'friend')) throw new AppError('invalid_configuration');
      const previous = (await tx.query('SELECT * FROM profiles WHERE demo_key=$1', [input.demoKey])).rows[0];
      if (previous) return this.mapProfile(previous);
      const id = randomUUID(); const now = this.now().toISOString();
      const inserted = await tx.query(`INSERT INTO profiles(id,demo_key,display_name,age_band,language_mode,timezone,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(demo_key) DO NOTHING RETURNING id`, [id, input.demoKey, input.displayName.normalize('NFC'), input.ageBand, input.languageMode, input.timezone, now]);
      if (!inserted.rows.length) return this.mapProfile((await tx.query('SELECT * FROM profiles WHERE demo_key=$1', [input.demoKey])).rows[0]!);
      await tx.query('INSERT INTO miu_configs(profile_id,personality,role,assigned_story_id) VALUES($1,$2,$3,$4)', [id, input.personality ?? 'ENFP', input.role ?? 'friend', chooseStory().templateId]);
      await tx.query('INSERT INTO demo_clocks(profile_id,mode,effective_anchor,wall_anchor) VALUES($1,$2,$3,$3)', [id, this.clockMode, now]);
      await tx.query('INSERT INTO relationship_states(profile_id) VALUES($1)', [id]);
      const row = await this.profile(tx, id);
      await this.rollover(tx, row, localDate(this.now(), input.timezone));
      return this.mapProfile((await this.profile(tx, id)));
    }));
  }
  async findProfile(demoKey: string): Promise<ChildProfile | null> {
    return this.serial(async () => {
      const row = (await this.db.query('SELECT * FROM profiles WHERE demo_key=$1', [demoKey])).rows[0];
      return row ? this.mapProfile(row) : null;
    });
  }
  async getClock(profileId: string): Promise<ClockState> {
    return this.serial(() => this.db.transaction(async (tx) => this.clock(tx, await this.profile(tx, profileId))));
  }
  async updateConfig(profileId: string, patch: { personality?: Personality; role?: Role; languageMode?: LanguageMode; voiceId?: string }): Promise<MemoryContext> {
    return this.serial(() => this.db.transaction(async (tx) => {
      const profile = await this.profile(tx, profileId);
      if (patch.personality !== undefined && !PERSONALITIES.includes(patch.personality)) throw new AppError('invalid_personality');
      if (patch.role !== undefined && !['friend', 'big_sibling', 'teacher'].includes(patch.role)) throw new AppError('invalid_role');
      if (patch.languageMode !== undefined && !['vi', 'en', 'follow_child'].includes(patch.languageMode)) throw new AppError('invalid_language');
      if (patch.voiceId !== undefined && !['miu-default'].includes(patch.voiceId)) throw new AppError('invalid_voice');
      await tx.query('UPDATE miu_configs SET personality=COALESCE($2,personality),role=COALESCE($3,role),voice_id=COALESCE($4,voice_id) WHERE profile_id=$1', [profileId, patch.personality ?? null, patch.role ?? null, patch.voiceId ?? null]);
      await tx.query('UPDATE profiles SET language_mode=COALESCE($2,language_mode),state_version=state_version+1 WHERE id=$1', [profileId, patch.languageMode ?? null]);
      return this.snapshot(tx, await this.profile(tx, str(profile.id)));
    }));
  }
  private async snapshot(tx: Queryable, profile: Row): Promise<MemoryContext> {
    const id = str(profile.id);
    await this.purge(tx, id);
    profile = await this.profile(tx, id);
    const clock = await this.clock(tx, profile);
    let dailyRow = (await tx.query('SELECT * FROM daily_states WHERE profile_id=$1', [id])).rows[0];
    if (!dailyRow || day(dailyRow.local_date) < clock.localDate) {
      await this.rollover(tx, profile, clock.localDate);
      dailyRow = (await tx.query('SELECT * FROM daily_states WHERE profile_id=$1', [id])).rows[0]!;
      profile = await this.profile(tx, id);
    }
    const [configRows, entityRows, preferenceRows, socialRows, eventRows, storyRows, checkpointRows, friendshipRows] = await Promise.all([
      tx.query('SELECT * FROM miu_configs WHERE profile_id=$1', [id]),
      tx.query(`SELECT e.*,r.expires_at,
        COALESCE((SELECT array_agg(a.alias) FROM entity_aliases a WHERE a.profile_id=e.profile_id AND a.entity_id=e.id),'{}') aliases,
        COALESCE((SELECT array_agg(DISTINCT o.previous_name_hash ORDER BY o.previous_name_hash)
          FROM memory_operation_receipts o WHERE o.profile_id=e.profile_id AND o.target_record_id=e.id
          AND o.previous_name_hash IS NOT NULL AND o.created_at > $2 AND o.created_at <= $3),'{}') retired_name_hashes
        FROM entities e JOIN memory_records r ON r.profile_id=e.profile_id AND r.id=e.id
        WHERE e.profile_id=$1 ORDER BY r.created_at,e.id LIMIT 100`, [id, new Date(this.now().getTime() - RETENTION).toISOString(), this.now().toISOString()]),
      tx.query('SELECT f.*,r.expires_at FROM facts f JOIN memory_records r ON r.profile_id=f.profile_id AND r.id=f.id WHERE f.profile_id=$1 ORDER BY r.created_at,f.id LIMIT 100', [id]),
      tx.query('SELECT s.*,e.name,r.expires_at FROM social_connections s JOIN entities e ON e.profile_id=s.profile_id AND e.id=s.entity_id JOIN memory_records r ON r.profile_id=s.profile_id AND r.id=s.id WHERE s.profile_id=$1 ORDER BY r.created_at,s.id LIMIT 100', [id]),
      tx.query('SELECT e.*,s.name subject_name,r.evidence_kind,r.source_turn_id,r.expires_at FROM events e LEFT JOIN entities s ON s.profile_id=e.profile_id AND s.id=e.subject_id JOIN memory_records r ON r.profile_id=e.profile_id AND r.id=e.id WHERE e.profile_id=$1 ORDER BY r.created_at DESC,e.id LIMIT 100', [id]),
      tx.query('SELECT s.*,r.expires_at FROM child_stories s JOIN memory_records r ON r.profile_id=s.profile_id AND r.id=s.id WHERE s.profile_id=$1 ORDER BY r.created_at,s.id LIMIT 50', [id]),
      tx.query("SELECT s.* FROM story_checkpoints s JOIN memory_records r ON r.profile_id=s.profile_id AND r.id=s.id WHERE s.profile_id=$1 ORDER BY (s.status='active') DESC,r.created_at DESC LIMIT 1", [id]),
      tx.query('SELECT stage FROM relationship_states WHERE profile_id=$1', [id]),
    ]);
    const config = configRows.rows[0]!;
    const checkpoint = checkpointRows.rows[0];
    return {
      profile: this.mapProfile(profile),
      config: { personality: config.personality as Personality, role: config.role as Role, voiceId: str(config.voice_id), canonVersion: str(config.canon_version), assignedStoryId: str(config.assigned_story_id) },
      clock, daily: authoredDay(day(dailyRow!.local_date), Number(dailyRow!.growth_days)),
      entities: entityRows.rows.map((r) => ({ id: str(r.id), kind: r.kind as MemoryContext['entities'][number]['kind'], name: str(r.name), species: r.species === null ? null : str(r.species), aliases: r.aliases as string[], expiresAt: iso(r.expires_at), ...((r.retired_name_hashes as string[]).length ? { retiredNameHashes: r.retired_name_hashes as string[] } : {}) })),
      preferences: preferenceRows.rows.map((r) => ({ id: str(r.id), category: r.category as MemoryContext['preferences'][number]['category'], value: str(r.value), expiresAt: iso(r.expires_at) })),
      socialCircle: socialRows.rows.map((r) => ({ id: str(r.id), entityId: str(r.entity_id), name: str(r.name), relation: str(r.relation), expiresAt: iso(r.expires_at) })),
      events: eventRows.rows.map((r) => ({ id: str(r.id), subjectId: r.subject_id === null ? null : str(r.subject_id), subjectName: r.subject_name === null ? null : str(r.subject_name), eventType: str(r.event_type), value: str(r.value), localDate: day(r.local_date), evidenceKind: r.evidence_kind as 'child_reported' | 'reported_plan', expiresAt: iso(r.expires_at), ...(r.source_evidence ? { source: { ...(r.source_evidence as AssertionEvidence), turnId: str(r.source_turn_id) } } : {}) })),
      stories: storyRows.rows.map((r) => ({ id: str(r.id), title: str(r.title), summary: str(r.summary), castNames: r.cast_names as string[], expiresAt: iso(r.expires_at) })),
      storyProgress: checkpoint ? storyAt(str(checkpoint.id), Number(checkpoint.chapter), str(checkpoint.template_id)) : null,
      friendship: friendshipRows.rows[0]!.stage as MemoryContext['friendship'],
    };
  }
  async getContext(profileId: string): Promise<MemoryContext> {
    return this.serial(() => this.db.transaction(async (tx) => this.snapshot(tx, await this.profile(tx, profileId))));
  }

  private async entity(tx: Queryable, profileId: string, source: string, key: string, kind: string, name: string, species: string | null): Promise<string> {
    const existing = (await tx.query('SELECT id,species FROM entities WHERE profile_id=$1 AND kind=$2 AND normalized_name=$3', [profileId, kind, normalized(name)])).rows[0];
    if (existing) {
      // Identical spelling alone cannot establish that a dog and cat are the
      // same animal. Preserve the known identity and ask for clarification.
      if (existing.species !== null && species !== null && normalized(str(existing.species)) !== normalized(species)) throw new AppError('ambiguous_name', 409);
      if (existing.species === null && species !== null) await tx.query('UPDATE entities SET species=$3 WHERE profile_id=$1 AND id=$2', [profileId, existing.id, species]);
      return str(existing.id);
    }
    const id = await this.record(tx, profileId, 'entity', source, key, kind === 'story_character' ? 'approved_fiction' : 'child_reported', kind === 'story_character' ? 'fictional' : 'reported_real');
    await tx.query('INSERT INTO entities(profile_id,id,kind,name,normalized_name,species) VALUES($1,$2,$3,$4,$5,$6)', [profileId, id, kind, name.normalize('NFC').trim(), normalized(name), species]);
    return id;
  }
  private async capture(tx: Queryable, input: LearningInput, candidate: MemoryCandidate, index: number): Promise<string[]> {
    const p = input.profileId; const source = input.turnId; const key = `candidate:${index}`;
    if (candidate.kind === 'entity') return [await this.entity(tx, p, source, key, candidate.entityKind, candidate.name, candidate.species)];
    if (candidate.kind === 'preference') {
      const canonicalKey = canonicalPreferenceKey(candidate.category, candidate.value);
      // Compare stored source values too, so old rows created before canonical
      // keys were introduced are not duplicated. The profile lock serializes this.
      const existing = (await tx.query('SELECT id,value FROM facts WHERE profile_id=$1 AND category=$2 ORDER BY id', [p, candidate.category])).rows
        .find(row => canonicalPreferenceKey(candidate.category, str(row.value)) === canonicalKey);
      if (existing) return [str(existing.id)];
      const id = await this.record(tx, p, 'preference', source, key);
      await tx.query('INSERT INTO facts(profile_id,id,category,value,normalized_value) VALUES($1,$2,$3,$4,$5)', [p, id, candidate.category, candidate.value.normalize('NFC').trim(), canonicalKey]);
      return [id];
    }
    if (candidate.kind === 'relationship') {
      const person = await this.entity(tx, p, source, `${key}:person`, 'person', candidate.name, null);
      const existing = (await tx.query('SELECT id FROM social_connections WHERE profile_id=$1 AND entity_id=$2 AND relation=$3', [p, person, candidate.relation])).rows[0];
      if (existing) return [person, str(existing.id)];
      const id = await this.record(tx, p, 'relationship', source, key);
      await tx.query('INSERT INTO social_connections(profile_id,id,entity_id,relation) VALUES($1,$2,$3,$4)', [p, id, person, candidate.relation]);
      await this.depend(tx, p, person, id);
      return [person, id];
    }
    if (candidate.kind === 'event') {
      let subjectId: string | null = null;
      if (candidate.subjectName) {
        const subjects = (await tx.query('SELECT id FROM entities WHERE profile_id=$1 AND normalized_name=$2', [p, normalized(candidate.subjectName)])).rows;
        if (subjects.length !== 1) return [];
        subjectId = str(subjects[0]!.id);
      }
      const evidence = candidate.eventType === 'planned_activity' ? 'reported_plan' : 'child_reported';
      const id = await this.record(tx, p, 'event', source, key, evidence);
      const eventDate = candidate.eventType === 'planned_activity' ? addDays(input.localDate, 1) : input.localDate;
      const sourceEvidence = assertionEvidence(input.sourceText, candidate);
      if (!sourceEvidence) throw new AppError('invalid_assertion');
      await tx.query('INSERT INTO events(profile_id,id,subject_id,event_type,value,local_date,source_evidence) VALUES($1,$2,$3,$4,$5,$6,$7)', [p, id, subjectId, candidate.eventType, candidate.value, eventDate, JSON.stringify(sourceEvidence)]);
      if (subjectId) await this.depend(tx, p, subjectId, id);
      return [id];
    }
    const resolvedCast: { name: string; id: string | null }[] = [];
    for (const name of candidate.castNames) {
      const known = (await tx.query('SELECT id FROM entities WHERE profile_id=$1 AND normalized_name=$2', [p, normalized(name)])).rows;
      if (known.length > 1) return [];
      resolvedCast.push({ name, id: known.length ? str(known[0]!.id) : null });
    }
    const cast: string[] = [];
    for (const [i, member] of resolvedCast.entries()) cast.push(member.id ?? await this.entity(tx, p, source, `${key}:cast:${i}`, 'story_character', member.name, null));
    const id = await this.record(tx, p, 'story', source, key, 'child_reported', 'fictional');
    await tx.query('INSERT INTO child_stories(profile_id,id,title,summary,cast_names) VALUES($1,$2,$3,$4,$5)', [p, id, candidate.title, candidate.summary, candidate.castNames]);
    for (const castId of cast) await this.depend(tx, p, castId, id);
    // Track known personal references in remembered prose even when a candidate
    // omitted them from its cast list, so deletion cannot leave a hidden copy.
    const references = (await tx.query('SELECT id,name value FROM entities WHERE profile_id=$1 UNION ALL SELECT id,value FROM facts WHERE profile_id=$1', [p])).rows;
    const prose = normalized(`${candidate.title} ${candidate.summary}`);
    for (const reference of references) if (prose.includes(normalized(str(reference.value)))) await this.depend(tx, p, str(reference.id), id);
    return [...cast, id];
  }
  async learn(input: LearningInput): Promise<{ learnedIds: string[]; applied: boolean }> {
    return this.serial(async () => {
      const result = await this.db.transaction(async (tx) => {
        await this.profile(tx, input.profileId);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) || !input.turnId || input.turnId.length > 128 || typeof input.sourceText !== 'string' || input.sourceText.length > 2_000 || input.candidates.length > 32) throw new AppError('invalid_learning');
        await this.purge(tx, input.profileId);
        const profile = await this.profile(tx, input.profileId);
        // Return a sentinel so the transaction commits expiry revocation before
        // the caller receives a conflict. Throwing here would roll that cleanup back.
        if (Number(profile.deletion_epoch) !== input.deletionEpoch) return null;
        if ((await tx.query('SELECT turn_id FROM turn_learning WHERE profile_id=$1 AND turn_id=$2', [input.profileId, input.turnId])).rows.length) return { learnedIds: [], applied: false };
        const learnedIds: string[] = [];
        // Entities precede events even if the classifier returned them in a different order.
        const candidates = input.candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => validateCandidate(candidate) && assertionEvidence(input.sourceText, candidate));
        candidates.sort((a, b) => Number(b.candidate.kind === 'entity') - Number(a.candidate.kind === 'entity'));
        for (const { candidate, index } of candidates) learnedIds.push(...await this.capture(tx, input, candidate, index));
        if (input.storyTransition) learnedIds.push(...await this.commitStory(tx, input));
        await tx.query("INSERT INTO turn_learning(profile_id,turn_id,deletion_epoch,status,completed_at) VALUES($1,$2,$3,'complete',$4)", [input.profileId, input.turnId, input.deletionEpoch, this.now().toISOString()]);
        if (learnedIds.length) await tx.query('UPDATE profiles SET state_version=state_version+1 WHERE id=$1', [input.profileId]);
        return { learnedIds: [...new Set(learnedIds)], applied: true };
      });
      if (result === null) throw new AppError('stale_state', 409);
      return result;
    });
  }
  private async checkpoint(tx: Queryable, profileId: string): Promise<Row | undefined> {
    return (await tx.query("SELECT s.* FROM story_checkpoints s JOIN memory_records r ON r.profile_id=s.profile_id AND r.id=s.id WHERE s.profile_id=$1 AND r.expires_at > $2 ORDER BY (s.status='active') DESC,r.created_at DESC LIMIT 1", [profileId, this.now().toISOString()])).rows[0];
  }
  private async assignedStoryId(tx: Queryable, profileId: string): Promise<string> {
    const config = (await tx.query('SELECT assigned_story_id FROM miu_configs WHERE profile_id=$1', [profileId])).rows[0]!;
    return str(config.assigned_story_id);
  }
  async previewStory(profileId: string, transition: 'start' | 'continue'): Promise<StoryProgress> {
    return this.serial(() => this.db.transaction(async (tx) => {
      await this.profile(tx, profileId);
      const row = await this.checkpoint(tx, profileId);
      if (!row || row.status === 'complete') return storyAt('preview', 0, await this.assignedStoryId(tx, profileId));
      return storyAt(str(row.id), Number(row.chapter) + (transition === 'continue' ? 1 : 0), str(row.template_id));
    }));
  }
  private async commitStory(tx: Queryable, input: LearningInput): Promise<string[]> {
    const row = await this.checkpoint(tx, input.profileId);
    const templateId = !row || row.status === 'complete' ? await this.assignedStoryId(tx, input.profileId) : str(row.template_id);
    const story = templateId === STORY.templateId ? STORY : getStory(templateId);
    let checkpointId: string; let chapter: number;
    if (!row || row.status === 'complete') {
      checkpointId = await this.record(tx, input.profileId, 'checkpoint', input.turnId, 'story:checkpoint', 'approved_fiction', 'fictional');
      chapter = 0;
      await tx.query("INSERT INTO story_checkpoints(profile_id,id,template_id,chapter,status) VALUES($1,$2,$3,0,$4)", [input.profileId, checkpointId, templateId, story.scenes.length === 1 ? 'complete' : 'active']);
    } else {
      checkpointId = str(row.id);
      chapter = Math.min(Number(row.chapter) + (input.storyTransition === 'continue' ? 1 : 0), story.scenes.length - 1);
      await tx.query('UPDATE story_checkpoints SET chapter=$3,status=$4 WHERE profile_id=$1 AND id=$2', [input.profileId, checkpointId, chapter, chapter === story.scenes.length - 1 ? 'complete' : 'active']);
      await tx.query("UPDATE promises SET status='fulfilled' WHERE profile_id=$1 AND checkpoint_id=$2 AND status='open'", [input.profileId, checkpointId]);
    }
    // A saved checkpoint does not imply Miu promised to resume it. Persist a
    // promise only when a future capture flow supplies an authorized heard one.
    return [checkpointId];
  }
  async reserveRecall(profileId: string, turnId: string): Promise<RecallHook | null> {
    return this.serial(() => this.db.transaction(async (tx) => {
      const profile = await this.profile(tx, profileId);
      await this.purge(tx, profileId);
      const clock = await this.clock(tx, profile);
      await tx.query("UPDATE followups SET status='eligible',reserved_turn_id=NULL,reserved_until=NULL WHERE profile_id=$1 AND status='reserved' AND reserved_until <= $2", [profileId, this.now().toISOString()]);
      const row = (await tx.query(`SELECT f.*,e.value,e.subject_id,s.name subject_name,r.evidence_kind FROM followups f
        JOIN memory_records r ON r.profile_id=f.profile_id AND r.id=f.id
        JOIN events e ON e.profile_id=f.profile_id AND e.id=f.source_id
        LEFT JOIN entities s ON s.profile_id=e.profile_id AND s.id=e.subject_id
        WHERE f.profile_id=$1 AND f.due_local_date <= $2 AND (f.status='eligible' OR (f.status='reserved' AND f.reserved_turn_id=$3))
        ORDER BY f.due_local_date,f.id LIMIT 1`, [profileId, clock.localDate, turnId])).rows[0];
      if (!row) return null;
      await tx.query("UPDATE followups SET status='reserved',reserved_turn_id=$3,reserved_until=$4 WHERE profile_id=$1 AND id=$2", [profileId, row.id, turnId, new Date(this.now().getTime() + 60_000).toISOString()]);
      return {
        id: str(row.id), sourceIds: [str(row.source_id), ...(row.subject_id ? [str(row.subject_id)] : [])],
        evidenceKind: row.evidence_kind as RecallHook['evidenceKind'],
        fact: str(row.value), question: { en: str(row.question_en), vi: str(row.question_vi) },
      };
    }));
  }
  async releaseRecall(profileId: string, turnId: string): Promise<void> {
    return this.serial(async () => { await this.db.query("UPDATE followups SET status='eligible',reserved_turn_id=NULL,reserved_until=NULL WHERE profile_id=$1 AND reserved_turn_id=$2 AND status='reserved'", [profileId, turnId]); });
  }
  async markPresented(profileId: string, turnId: string): Promise<void> {
    return this.serial(async () => { await this.db.query("UPDATE followups SET status='presented',reserved_until=NULL WHERE profile_id=$1 AND reserved_turn_id=$2 AND status='reserved'", [profileId, turnId]); });
  }
  async forget(profileId: string, targetId: string | 'all', expectedEpoch?: number): Promise<ForgetResult> {
    return this.serial(() => this.db.transaction(async (tx) => {
      const profile = await this.profile(tx, profileId);
      if (expectedEpoch !== undefined && Number(profile.deletion_epoch) !== expectedEpoch) throw new AppError('stale_state', 409);
      let roots: string[];
      if (targetId === 'all') roots = (await tx.query<{ id: string }>("SELECT id FROM memory_records WHERE profile_id=$1 AND kind <> 'diary'", [profileId])).rows.map((row) => row.id);
      else {
        const followup = (await tx.query('SELECT source_id FROM followups WHERE profile_id=$1 AND id=$2', [profileId, targetId])).rows[0];
        const actual = followup ? str(followup.source_id) : targetId;
        const record = (await tx.query('SELECT id FROM memory_records WHERE profile_id=$1 AND id=$2', [profileId, actual])).rows[0];
        if (!record) throw new AppError('memory_not_found', 404);
        roots = [actual];
      }
      const deletedIds = await this.deleteClosure(tx, profileId, roots);
      if (targetId === 'all') await tx.query('DELETE FROM memory_operation_receipts WHERE profile_id=$1', [profileId]);
      await tx.query('UPDATE profiles SET deletion_epoch=deletion_epoch+1,state_version=state_version+1 WHERE id=$1', [profileId]);
      await tx.query("UPDATE relationship_states SET stage='getting_acquainted',familiarity_permitted=false WHERE profile_id=$1", [profileId]);
      const updated = await this.profile(tx, profileId);
      return { deletedIds, deletionEpoch: Number(updated.deletion_epoch), stateVersion: Number(updated.state_version) };
    }));
  }
  /** Retraction revokes an event and its derived hooks, preserving its subject
   * and unrelated memories. It does not change the friendship stage. */
  async retractEvent(profileId: string, eventId: string, expectedEpoch: number): Promise<ForgetResult> {
    return this.serial(() => this.db.transaction(async tx => {
      const profile = await this.profile(tx, profileId);
      if (Number(profile.deletion_epoch) !== expectedEpoch) throw new AppError('stale_state', 409);
      if (!(await tx.query('SELECT id FROM events WHERE profile_id=$1 AND id=$2', [profileId, eventId])).rows.length) throw new AppError('memory_not_found', 404);
      const deletedIds = await this.deleteClosure(tx, profileId, [eventId]);
      await tx.query('UPDATE profiles SET deletion_epoch=deletion_epoch+1,state_version=state_version+1 WHERE id=$1', [profileId]);
      const updated = await this.profile(tx, profileId);
      return { deletedIds, deletionEpoch: Number(updated.deletion_epoch), stateVersion: Number(updated.state_version) };
    }));
  }
  async correctEntity(profileId: string, entityId: string, name: string, expectedEpoch?: number, provenance?: { turnId: string; evidence: string }): Promise<ForgetResult> {
    const correctedName = name.normalize('NFC').trim();
    if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]{0,79}$/u.test(correctedName) || !isSafeProjection(correctedName)) throw new AppError('invalid_name');
    if (provenance && (!provenance.turnId || provenance.turnId.length > 128 || /[\u0000-\u001f]/u.test(provenance.turnId) || !isSafeProjection(provenance.evidence) || provenance.evidence.length > 500 || !provenance.evidence.normalize('NFC').includes(correctedName))) throw new AppError('invalid_correction_evidence');
    const fingerprint = provenance ? createHash('sha256').update(JSON.stringify({ profileId, entityId, name: correctedName, evidence: provenance.evidence.normalize('NFC') })).digest('hex') : null;
    return this.serial(async () => {
      const outcome = await this.db.transaction(async (tx): Promise<{ value: ForgetResult } | { error: AppError }> => {
      await this.profile(tx, profileId);
      await this.purge(tx, profileId);
      const profile = await this.profile(tx, profileId);
      const entity = (await tx.query('SELECT * FROM entities WHERE profile_id=$1 AND id=$2', [profileId, entityId])).rows[0];
      if (provenance) {
        const receipt = (await tx.query('SELECT * FROM memory_operation_receipts WHERE profile_id=$1 AND turn_id=$2', [profileId, provenance.turnId])).rows[0];
        if (receipt) {
          if (receipt.request_hash !== fingerprint || receipt.target_record_id !== entityId || receipt.operation_kind !== 'entity_rename') return { error: new AppError('idempotency_conflict', 409) };
          // An old retry cannot overwrite a newer correction. Fresh versions let
          // the application rebase its acknowledgment against current state.
          if (!entity || str(entity.name) !== correctedName) return { error: new AppError('stale_state', 409) };
          return { value: { deletedIds: receipt.invalidated_record_ids as string[], deletionEpoch: Number(profile.deletion_epoch), stateVersion: Number(profile.state_version) } };
        }
      }
      if (expectedEpoch !== undefined && Number(profile.deletion_epoch) !== expectedEpoch) return { error: new AppError('stale_state', 409) };
      if (!entity) return { error: new AppError('memory_not_found', 404) };
      if ((await tx.query('SELECT id FROM entities WHERE profile_id=$1 AND kind=$2 AND normalized_name=$3 AND id<>$4', [profileId, entity.kind, normalized(correctedName), entityId])).rows.length) return { error: new AppError('ambiguous_name', 409) };
      await tx.query('UPDATE entities SET name=$3,normalized_name=$4 WHERE profile_id=$1 AND id=$2', [profileId, entityId, correctedName, normalized(correctedName)]);
      await tx.query('DELETE FROM entity_aliases WHERE profile_id=$1 AND entity_id=$2', [profileId, entityId]);
      if (provenance) {
        // The corrected name is supported by this turn, not by the original
        // mistaken disclosure. Keep the entity ID and original creation time.
        await tx.query('UPDATE memory_records SET source_turn_id=$3,candidate_key=$4,expires_at=$5 WHERE profile_id=$1 AND id=$2', [profileId, entityId, provenance.turnId, `entity_rename:${entityId}`, new Date(this.now().getTime() + RETENTION).toISOString()]);
      }
      const events = (await tx.query('SELECT id,value FROM events WHERE profile_id=$1 AND subject_id=$2', [profileId, entityId])).rows;
      for (const event of events) await tx.query('UPDATE events SET value=$3 WHERE profile_id=$1 AND id=$2', [profileId, event.id, str(event.value).split(str(entity.name)).join(correctedName)]);
      const hooks = (await tx.query('SELECT f.* FROM followups f JOIN events e ON e.profile_id=f.profile_id AND e.id=f.source_id WHERE f.profile_id=$1 AND e.subject_id=$2', [profileId, entityId])).rows;
      for (const hook of hooks) await tx.query("UPDATE followups SET question_en=$3,question_vi=$4,status=CASE WHEN status='reserved' THEN 'eligible' ELSE status END,reserved_turn_id=NULL,reserved_until=NULL WHERE profile_id=$1 AND id=$2", [profileId, hook.id, str(hook.question_en).split(str(entity.name)).join(correctedName), str(hook.question_vi).split(str(entity.name)).join(correctedName)]);
      // A remembered story may contain the old proper name in prose: remove it,
      // rather than let a stale story reintroduce a corrected identity.
      const stories = (await tx.query<{ id: string }>(`WITH RECURSIVE dependents(id) AS (
        SELECT derived_id FROM memory_dependencies WHERE profile_id=$1 AND source_id=$2
        UNION SELECT d.derived_id FROM memory_dependencies d JOIN dependents p ON p.id=d.source_id WHERE d.profile_id=$1
      ) SELECT r.id FROM memory_records r JOIN dependents d ON d.id=r.id WHERE r.profile_id=$1 AND r.kind IN ('story','self_statement')`, [profileId, entityId])).rows;
      const deletedIds = await this.deleteClosure(tx, profileId, stories.map((row) => row.id));
      await tx.query('UPDATE profiles SET deletion_epoch=deletion_epoch+1,state_version=state_version+1 WHERE id=$1', [profileId]);
      const updated = await this.profile(tx, profileId);
      const value = { deletedIds, deletionEpoch: Number(updated.deletion_epoch), stateVersion: Number(updated.state_version) };
      if (provenance) await tx.query(`INSERT INTO memory_operation_receipts(profile_id,turn_id,operation_kind,target_record_id,request_hash,invalidated_record_ids,applied_state_version,applied_deletion_epoch,created_at,previous_name_hash)
        VALUES($1,$2,'entity_rename',$3,$4,$5,$6,$7,$8,$9)`, [profileId, provenance.turnId, entityId, fingerprint, deletedIds, value.stateVersion, value.deletionEpoch, this.now().toISOString(), retiredNameHash(profileId, str(entity.name))]);
      return { value };
      });
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    });
  }
  private async rollover(tx: Queryable, profile: Row, targetDate: string): Promise<boolean> {
    const profileId = str(profile.id);
    if ((await tx.query('SELECT local_date FROM night_job_runs WHERE profile_id=$1 AND local_date=$2', [profileId, targetDate])).rows.length) return false;
    await this.purge(tx, profileId);
    const growth = (await tx.query('SELECT * FROM character_growth WHERE profile_id=$1', [profileId])).rows[0];
    if (growth && targetDate < day(growth.last_local_date)) throw new AppError('clock_cannot_go_back', 409);
    const growthDays = growth ? Math.max(Number(growth.growth_days), dateDifference(day(growth.first_local_date), targetDate)) : 0;
    const authored = authoredDay(targetDate, growthDays);
    await tx.query(`INSERT INTO character_growth(profile_id,first_local_date,last_local_date,growth_days) VALUES($1,$2,$2,$3)
      ON CONFLICT(profile_id) DO UPDATE SET last_local_date=EXCLUDED.last_local_date,growth_days=EXCLUDED.growth_days`, [profileId, targetDate, growthDays]);
    const diaryId = await this.record(tx, profileId, 'diary', `night:${targetDate}`, 'diary', 'approved_fiction', 'fictional');
    await tx.query('INSERT INTO diary_entries(profile_id,id,local_date,template_id) VALUES($1,$2,$3,$4)', [profileId, diaryId, targetDate, authored.diary.templateId]);
    await tx.query(`INSERT INTO daily_states(profile_id,local_date,mood,growth_days,growth_theme,diary_template_id,episode_template_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(profile_id) DO UPDATE SET local_date=EXCLUDED.local_date,mood=EXCLUDED.mood,growth_days=EXCLUDED.growth_days,growth_theme=EXCLUDED.growth_theme,diary_template_id=EXCLUDED.diary_template_id,episode_template_id=EXCLUDED.episode_template_id`,
    [profileId, targetDate, authored.mood, growthDays, authored.growthTheme, authored.diary.templateId, authored.storyEpisode.templateId]);
    const events = (await tx.query(`SELECT e.*,s.name,s.species,r.expires_at FROM events e
      JOIN memory_records r ON r.profile_id=e.profile_id AND r.id=e.id
      LEFT JOIN entities s ON s.profile_id=e.profile_id AND s.id=e.subject_id
      WHERE e.profile_id=$1 AND e.local_date < $2 AND e.event_type IN ('fell_in_puddle','planned_activity')`, [profileId, targetDate])).rows;
    for (const event of events) {
      if (event.event_type === 'fell_in_puddle' && event.species !== 'dog') continue;
      if (event.event_type === 'planned_activity' && !/drawing|vẽ/iu.test(str(event.value))) continue;
      const rule = event.event_type === 'fell_in_puddle' ? 'puddle-bath-v1' : 'drawing-plan-v1';
      if ((await tx.query('SELECT id FROM followups WHERE profile_id=$1 AND source_id=$2 AND rule_id=$3', [profileId, event.id, rule])).rows.length) continue;
      const id = await this.record(tx, profileId, 'followup', `night:${targetDate}`, `followup:${event.id}:${rule}`, event.event_type === 'fell_in_puddle' ? 'inferred_question' : 'reported_plan', 'reported_real', iso(event.expires_at));
      const name = str(event.name);
      await tx.query('INSERT INTO followups(profile_id,id,source_id,rule_id,due_local_date,question_en,question_vi) VALUES($1,$2,$3,$4,$5,$6,$7)', [profileId, id, event.id, rule, addDays(day(event.local_date), 1), event.event_type === 'fell_in_puddle' ? `Did ${name} get a bath?` : 'How did your drawing go?', event.event_type === 'fell_in_puddle' ? `${name} được tắm chưa?` : 'Buổi vẽ của bạn thế nào?']);
      await this.depend(tx, profileId, str(event.id), id);
    }
    await tx.query('INSERT INTO night_job_runs(profile_id,local_date,completed_at) VALUES($1,$2,$3)', [profileId, targetDate, this.now().toISOString()]);
    await tx.query('UPDATE profiles SET state_version=state_version+1 WHERE id=$1', [profileId]);
    return true;
  }
  async runNightJob(profileId: string, targetLocalDate?: string): Promise<NightJobResult> {
    return this.serial(() => this.db.transaction(async (tx) => {
      const profile = await this.profile(tx, profileId); const clock = await this.clock(tx, profile);
      const target = targetLocalDate ?? clock.localDate;
      if (target !== clock.localDate) throw new AppError('invalid_rollover_date', 409);
      const applied = await this.rollover(tx, profile, target);
      const context = await this.snapshot(tx, await this.profile(tx, profileId));
      return { daily: context.daily, clock: context.clock, stateVersion: context.profile.stateVersion, applied };
    }));
  }
  async nextDay(profileId: string, requestId: string, expectedClockVersion: number): Promise<NightJobResult> {
    return this.serial(() => this.db.transaction(async (tx) => {
      const profile = await this.profile(tx, profileId);
      const old = (await tx.query('SELECT * FROM clock_requests WHERE profile_id=$1 AND request_id=$2', [profileId, requestId])).rows[0];
      if (old) {
        if (Number(old.expected_version) !== expectedClockVersion) throw new AppError('idempotency_conflict', 409);
        return { ...(old.result as NightJobResult), applied: false };
      }
      const clock = await this.clock(tx, profile);
      if (clock.mode !== 'demo') throw new AppError('demo_clock_disabled', 404);
      if (clock.version !== expectedClockVersion) throw new AppError('stale_clock', 409);
      if (!requestId || requestId.length > 128) throw new AppError('invalid_request');
      const target = addDays(clock.localDate, 1);
      const applied = await this.rollover(tx, profile, target);
      await tx.query('UPDATE demo_clocks SET effective_anchor=$2,wall_anchor=$3,version=version+1 WHERE profile_id=$1', [profileId, atLocalHour(target, str(profile.timezone)).toISOString(), this.now().toISOString()]);
      const context = await this.snapshot(tx, await this.profile(tx, profileId));
      const result: NightJobResult = { daily: context.daily, clock: context.clock, stateVersion: context.profile.stateVersion, applied };
      await tx.query('INSERT INTO clock_requests(profile_id,request_id,expected_version,result,created_at) VALUES($1,$2,$3,$4,$5)', [profileId, requestId, expectedClockVersion, JSON.stringify(result), this.now().toISOString()]);
      return result;
    }));
  }
  async close(): Promise<void> { await this.queue; await this.db.close(); }
}
