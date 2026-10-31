/** Errors contain technical codes only; applications should supply localized captions. */
export class VoiceClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'VoiceClientError';
  }
}

export function canceledError(): VoiceClientError {
  return new VoiceClientError('CANCELED', 'The voice operation was canceled.');
}

export function isCanceled(error: unknown): boolean {
  return (error instanceof VoiceClientError && error.code === 'CANCELED')
    || (error instanceof Error && error.name === 'AbortError');
}

export function asClientError(error: unknown, code = 'VOICE_FAILED'): VoiceClientError {
  if (error instanceof VoiceClientError) return error;
  if (isCanceled(error)) return canceledError();
  return new VoiceClientError(code, 'The voice operation could not be completed.', true);
}

/** Observers must not be able to interrupt cleanup or audio lifecycle transitions. */
export function notify<T>(listeners: Iterable<(event: T) => void>, event: T): void {
  for (const listener of listeners) {
    try { listener(event); } catch { /* UI observer errors do not change audio ownership. */ }
  }
}
