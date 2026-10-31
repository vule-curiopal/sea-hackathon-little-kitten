import { resolve } from 'node:path';
import { DEFAULT_VOICE, VOICES, type FamilyConfig, type Language, type PlaybackReceipt } from '@miu/voice-contracts';
import { MiuApplication, type TurnRequest } from '../application.js';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { OpenAIProvider } from '../pipeline/providers.js';
import type { EngineBridge, EnginePreparedTurn, EngineProfileSnapshot, EngineSessionSnapshot } from '../pipeline/src/ports.js';
import { AppError, PERSONALITIES, type MemoryContext, type Personality } from '../shared/types.js';
import { createVectorMemoryFromEnv, vectorBackend, vectorSearchEnabled } from '../memory/vector/service.js';

export interface EngineBridgeOptions {
  /** Passing an environment makes startup hermetic; this module never reads .env files. */
  env?: Readonly<Record<string, string | undefined>>;
  databaseUrl?: string;
  dataDir?: string;
  defaultVoices?: Readonly<Record<Language, string>>;
  defaultLanguage?: Language;
  clockMode?: 'real' | 'demo';
  now?: () => Date;
  providerTimeoutMs?: number;
  turnTimeoutMs?: number;
}

function validVoice(language: Language, voiceId: string): boolean {
  return VOICES.some(voice => voice.language === language && voice.id === voiceId);
}

function positiveTimeout(value: number | undefined, source: string | undefined, fallback: number): number {
  const result = value ?? (source === undefined ? fallback : Number(source));
  if (!Number.isSafeInteger(result) || result <= 0 || result > 600_000) throw new AppError('invalid_provider_timeout', 503);
  return result;
}

/** Adapt the persistent engine to voice transport without duplicating its state. */
export class PersistentEngineBridge implements EngineBridge {
  readonly mode = 'real' as const;
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    readonly application: MiuApplication,
    private readonly voices: Readonly<Record<Language, string>>,
    private readonly defaultLanguage: Language,
  ) {
    if (application.provider.mode !== 'real') throw new AppError('real_model_required', 503);
    for (const language of ['vi', 'en'] as const) {
      if (!validVoice(language, voices[language])) throw new AppError('invalid_voice', 503);
    }
  }

  private profileId(token: string): string {
    if (this.closed) throw new AppError('engine_closed', 503);
    return this.application.profileForToken(token);
  }

  private async serial<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AppError('engine_closed', 503);
    const previous = this.queues.get(profileId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      if (this.closed) throw new AppError('engine_closed', 503);
      return work();
    });
    this.queues.set(profileId, current);
    try { return await current; }
    finally { if (this.queues.get(profileId) === current) this.queues.delete(profileId); }
  }

  private async snapshot(context: MemoryContext): Promise<EngineProfileSnapshot> {
    const language = context.profile.languageMode;
    if (language !== 'vi' && language !== 'en') throw new AppError('fixed_language_required', 409);
    const saved = (await this.application.memory.db.query<{ voice_id: string }>(
      'SELECT voice_id FROM integration_voice_settings WHERE profile_id=$1', [context.profile.id],
    )).rows[0]?.voice_id;
    // A language switch selects that language's default unless an allowed voice
    // was explicitly supplied. Internal engine voice IDs never reach ElevenLabs.
    const voiceId = saved && validVoice(language, saved) ? saved : this.voices[language];
    return {
      configuration: { personality: context.config.personality, role: context.config.role, language_mode: language, voice_id: voiceId },
      state_version: context.profile.stateVersion,
      clock_version: context.clock.version,
      effective_now: context.clock.effectiveNow,
    };
  }

  async openSession(key: string): Promise<EngineSessionSnapshot> {
    if (this.closed) throw new AppError('engine_closed', 503);
    if (!['an', 'binh'].includes(key)) throw new AppError('unknown_demo_profile', 400);
    const profile = await this.application.memory.findProfile(key);
    if (!profile) throw new AppError('profile_not_found', 404);
    return this.serial(profile.id, async () => {
      const current = await this.application.getContext(profile.id);
      if (current.profile.languageMode === 'follow_child') {
        await this.application.updateConfig(profile.id, { languageMode: this.defaultLanguage });
      }
      const session = await this.application.openSession(key);
      return { session_id: session.session_id, demo_token: session.demo_token, ...await this.snapshot(session.context) };
    });
  }

  async context(token: string): Promise<EngineProfileSnapshot> {
    const profileId = this.profileId(token);
    return this.serial(profileId, async () => this.snapshot(await this.application.getContext(profileId)));
  }

  async getContext(token: string): Promise<MemoryContext> {
    const profileId = this.profileId(token);
    return this.serial(profileId, () => this.application.getContext(profileId));
  }

  async demoPanel(token: string) {
    const profileId = this.profileId(token);
    return this.serial(profileId, async () => {
      const context = await this.application.getContext(profileId);
      return { ...context, ...await this.snapshot(context), provider_mode: this.mode, engine_mode: 'character_memory' as const };
    });
  }

  async configure(token: string, patch: Partial<FamilyConfig>): Promise<EngineProfileSnapshot> {
    const profileId = this.profileId(token);
    return this.serial(profileId, async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['personality', 'role', 'language_mode', 'voice_id'].includes(key))) throw new AppError('invalid_configuration');
      if (patch.personality !== undefined && !PERSONALITIES.includes(patch.personality as Personality)) throw new AppError('invalid_personality');
      if (patch.role !== undefined && !['friend', 'big_sibling', 'teacher'].includes(patch.role)) throw new AppError('invalid_role');
      if (patch.language_mode !== undefined && !['vi', 'en'].includes(patch.language_mode)) throw new AppError('invalid_language');
      const before = await this.application.getContext(profileId);
      const language = patch.language_mode ?? before.profile.languageMode;
      if (language !== 'vi' && language !== 'en') throw new AppError('fixed_language_required', 409);
      if (patch.voice_id !== undefined && !validVoice(language, patch.voice_id)) throw new AppError('invalid_voice');
      const current = await this.snapshot(before);
      const voiceId = patch.voice_id ?? (current.configuration.language_mode === language ? current.configuration.voice_id : this.voices[language]);
      const context = await this.application.updateConfig(profileId, {
        personality: patch.personality as Personality | undefined,
        role: patch.role,
        languageMode: language,
        // The engine's delivery identity and the provider's synthesis voice have
        // separate allowlists. The latter is bridge-owned persistent metadata.
        voiceId: 'miu-default',
      });
      try {
        await this.application.memory.db.query(`INSERT INTO integration_voice_settings(profile_id,voice_id)
          VALUES($1,$2) ON CONFLICT(profile_id) DO UPDATE SET voice_id=EXCLUDED.voice_id,updated_at=now()`, [profileId, voiceId]);
      } catch {
        const failure = new AppError('voice_configuration_unavailable', 503);
        failure.invalidation = { state_version: context.profile.stateVersion, clock_version: context.clock.version, memory: { invalidate_replay: true } };
        throw failure;
      }
      return this.snapshot(context);
    });
  }

  async prepare(token: string, sessionId: string, input: TurnRequest, signal: AbortSignal): Promise<EnginePreparedTurn> {
    const profileId = this.profileId(token);
    if (signal.aborted) throw new AppError('turn_canceled', 409);
    let allocated = false;
    const cleanup = () => {
      // Do not wait behind the bridge queue: a provider can still be generating.
      // prepareTurn allocates before its first provider request; final cleanup
      // below covers an abort that raced with that allocation.
      if (allocated) void this.application.cancel(profileId, sessionId, input.request_id).catch(() => undefined);
    };
    signal.addEventListener('abort', cleanup, { once: true });
    try {
      const response = await this.serial(profileId, async () => {
        if (signal.aborted) throw new AppError('turn_canceled', 409);
        allocated = true;
        return this.application.prepareTurn(profileId, sessionId, input);
      });
      if (signal.aborted) {
        await this.application.cancel(profileId, sessionId, response.turn_id).catch(() => undefined);
        throw new AppError('turn_canceled', 409);
      }
      return { ...response, face: response.presentation.face };
    } catch (error) {
      if (signal.aborted && allocated) {
        await this.application.cancel(profileId, sessionId, input.request_id).catch(() => undefined);
        throw new AppError('turn_canceled', 409);
      }
      throw error;
    } finally { signal.removeEventListener('abort', cleanup); }
  }

  async playback(token: string, sessionId: string, turnId: string, receipt: PlaybackReceipt): Promise<unknown> {
    const profileId = this.profileId(token);
    // The transport validates actual audio/visible delivery and played_ms. Only
    // that receipt may unlock the engine's completed-playback memory learning.
    return this.application.playback(profileId, sessionId, turnId, {
      request_id: receipt.request_id, status: receipt.status, state_version: receipt.state_version,
    });
  }

  async cancel(token: string, sessionId: string, turnId: string): Promise<unknown> {
    return this.application.cancel(this.profileId(token), sessionId, turnId);
  }

  async closeSession(token: string, sessionId: string): Promise<unknown> {
    return this.application.closeSession(this.profileId(token), sessionId);
  }

  async nextDay(token: string, requestId: string, expectedClockVersion: number) {
    const profileId = this.profileId(token);
    return this.serial(profileId, () => this.application.nextDay(profileId, requestId, expectedClockVersion));
  }

  async maintain(): Promise<void> {
    if (this.closed) return;
    await this.application.maintain();
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = (async () => {
        // Abort active engine work before waiting for queued bridge operations.
        await this.application.close();
        await Promise.allSettled([...this.queues.values()]);
      })();
    }
    return this.closePromise;
  }
}

/** A real OpenAI client is mandatory. No fake provider is constructed here. */
export async function createEngineBridge(options: EngineBridgeOptions = {}): Promise<PersistentEngineBridge> {
  const env = options.env ?? process.env;
  if (!env.OPENAI_API_KEY?.trim()) throw new AppError('missing_openai_key', 503);
  const defaultLanguage = options.defaultLanguage ?? 'vi';
  if (!['vi', 'en'].includes(defaultLanguage)) throw new AppError('invalid_language', 503);
  const voices = { ...DEFAULT_VOICE, ...options.defaultVoices };
  for (const language of ['vi', 'en'] as const) {
    if (!validVoice(language, voices[language])) throw new AppError('invalid_voice', 503);
  }
  const provider = new OpenAIProvider({
    apiKey: env.OPENAI_API_KEY,
    classifyModel: env.OPENAI_CLASSIFY_MODEL,
    replyModel: env.OPENAI_REPLY_MODEL,
    checkModel: env.OPENAI_CHECK_MODEL,
    moderationModel: env.OPENAI_MODERATION_MODEL,
    timeoutMs: positiveTimeout(options.providerTimeoutMs, env.OPENAI_TIMEOUT_MS, 60_000),
    evaluationMode: true,
  });
  const now = options.now ?? (() => new Date());
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (databaseUrl !== undefined && !databaseUrl.trim()) throw new AppError('invalid_database_configuration', 503);
  const memory: MemoryStore = await createMemoryStore({
    databaseUrl,
    dataDir: databaseUrl ? undefined : options.dataDir ?? env.MIU_DATA_DIR ?? resolve('.miu-data'),
    now,
    clockMode: options.clockMode ?? 'demo',
    vectorExtension: vectorSearchEnabled(env) && vectorBackend(env) === 'pgvector',
  });
  let retrieval;
  try { retrieval = await createVectorMemoryFromEnv(memory, env); }
  catch (error) { await memory.close(); throw error; }
  const application = new MiuApplication(memory, provider, () => now().getTime(), {
    evaluateRealModel: true,
    turnTimeoutMs: positiveTimeout(options.turnTimeoutMs, env.ENGINE_TURN_TIMEOUT_MS, 180_000),
    retrieval,
  });
  try {
    await memory.db.exec(`CREATE TABLE IF NOT EXISTS integration_voice_settings (
      profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      voice_id text NOT NULL CHECK (length(voice_id) BETWEEN 1 AND 100),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const [demoKey, displayName] of [['an', 'An'], ['binh', 'Bình']] as const) {
      if (!await memory.findProfile(demoKey)) {
        await memory.createProfile({ demoKey, displayName, ageBand: '6-8', languageMode: defaultLanguage, timezone: 'Asia/Ho_Chi_Minh' });
      }
    }
    await application.bootstrap();
    return new PersistentEngineBridge(application, voices, defaultLanguage);
  } catch (error) { await application.close(); throw error; }
}
