export class PipelineError extends Error {
  constructor(public readonly code: string, public readonly status = 503, public readonly retryable = false) { super(code); this.name = 'PipelineError'; }
}
export function abortError(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PipelineError('turn_canceled', 409);
}
