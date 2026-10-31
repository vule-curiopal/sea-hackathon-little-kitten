type Fields = Record<string, unknown>;
const ids = new Set(['session_id', 'turn_id', 'connection_id']);
const numbers = new Set(['duration_ms', 'audio_ms', 'bytes', 'chunks', 'characters', 'partials', 'segments', 'silence_ms', 'status', 'close_code']);
const labels = new Set(['stage', 'code', 'input_mode', 'provider_event', 'outcome']);

/** Allowlisted metadata only: no bodies, tokens, audio, words, URLs, messages or stacks. */
export function createLogger(write: (line: string) => void) {
  return (event: string, fields: Fields = {}) => {
    if (!/^[a-z][a-z0-9_.]{0,79}$/.test(event)) return;
    const entry: Fields = { time: new Date().toISOString(), level: /failed|rejected|client.error/.test(event) ? 'warn' : 'info', service: 'miu-voice', event };
    for (const [key, value] of Object.entries(fields)) {
      if (ids.has(key) && typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) entry[key] = value;
      if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) entry[key] = Math.round(value);
      if (labels.has(key) && typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/.test(value)) entry[key] = value;
    }
    try { write(JSON.stringify(entry) + '\n'); } catch { /* Diagnostics must not break a turn. */ }
  };
}

export const logEvent = createLogger(line => {
  if (process.env.VITEST !== 'true') process.stdout.write(line);
});

export function errorFields(error: unknown): { code: string; status?: number } {
  if (error instanceof Error) {
    const value = error as Error & { code?: unknown; status?: unknown };
    if (['PipelineError', 'AppError'].includes(value.constructor.name) && typeof value.code === 'string'
      && /^[a-z][a-z0-9_]{0,79}$/.test(value.code)) {
      return { code: value.code, ...(typeof value.status === 'number' && value.status >= 400 && value.status <= 599 ? { status: value.status } : {}) };
    }
  }
  return { code: 'internal_error' };
}
