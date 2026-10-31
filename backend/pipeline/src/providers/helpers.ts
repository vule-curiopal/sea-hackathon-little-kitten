import { PipelineError, abortError } from '../errors.js';

/** Enforce cancellation even when a transport or mock ignores its AbortSignal. */
export async function runStage<T>(parent: AbortSignal, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  abortError(parent);
  const controller = new AbortController();
  let rejectAbort!: (error: PipelineError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const stop = (error: PipelineError): void => { controller.abort(error); rejectAbort(error); };
  const onParentAbort = (): void => stop(new PipelineError('turn_canceled', 409));
  parent.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => stop(new PipelineError('provider_timeout', 504, true)), timeoutMs);
  try {
    const result = await Promise.race([work(controller.signal), aborted]);
    abortError(parent);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (error) {
    if (parent.aborted) throw new PipelineError('turn_canceled', 409);
    if (controller.signal.aborted) throw new PipelineError('provider_timeout', 504, true);
    if (error instanceof PipelineError) throw error;
    if (isRecord(error) && (error.name === 'APIConnectionTimeoutError' || error.name === 'TimeoutError')) throw new PipelineError('provider_timeout', 504, true);
    if (isRecord(error) && typeof error.status === 'number') throw upstreamFailure(error.status);
    // Do not let upstream exceptions, SDK response bodies or credentials escape.
    throw new PipelineError('provider_unavailable', 503, true);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onParentAbort);
  }
}

export function upstreamFailure(status: number): PipelineError {
  return new PipelineError('provider_unavailable', 503, status === 429 || status >= 500);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bound bytes before parsing JSON or passing audio to the decoder/probe. */
export async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  abortError(signal);
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new PipelineError('provider_unavailable', 503);
  }
  if (!response.body) throw new PipelineError('provider_unavailable', 503);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      abortError(signal);
      const { done, value } = await reader.read();
      abortError(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancel();
        throw new PipelineError('provider_unavailable', 503);
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (total === 0) throw new PipelineError('provider_unavailable', 503);
  return Buffer.concat(parts, total);
}

export async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw upstreamFailure(response.status);
  }
  const bytes = await readBounded(response, 512 * 1024, signal);
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new PipelineError('provider_unavailable', 503); }
}
