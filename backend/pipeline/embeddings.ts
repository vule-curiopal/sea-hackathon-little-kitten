import OpenAI from 'openai-engine';
import { AppError } from '../shared/types.js';

export const EMBEDDING_MAX_BATCH = 32;
/** UTF-8 byte count conservatively bounds ordinary byte-BPE tokens, enforcing
 * the 512-token canonical projection budget without an estimated tokenizer. */
export const EMBEDDING_MAX_INPUT_BYTES = 512;
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  usage: { promptTokens: number; totalTokens: number };
  requestId: string | null;
  elapsedMs: number;
}
export interface EmbeddingProvider {
  readonly mode: 'real';
  readonly model: string;
  readonly dimensions: number;
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}
/** Injectable transport is solely for offline adapter-contract tests. It does
 * not provide embedding or character quality evidence. */
export interface OpenAIEmbeddingTransport {
  embeddings: {
    create(body: { input: string[]; model: string; dimensions: number; encoding_format: 'float' },
      options: { signal: AbortSignal; timeout: number; maxRetries: 0 }): Promise<unknown>;
  };
}
export interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  client?: OpenAIEmbeddingTransport;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}
export interface OpenAIEmbeddingTelemetry {
  sequence: number;
  api: 'embeddings';
  requestedModel: string;
  returnedModel: string | null;
  dimensions: number;
  batchSize: number;
  requestId: string | null;
  startedAt: string;
  elapsedMs: number;
  outcome: 'completed' | 'failed';
  promptTokens: number | null;
  totalTokens: number | null;
  errorCode: string | null;
  httpStatus: number | null;
}

const QUOTA_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_not_active', 'billing_hard_limit_reached',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'usage_limit_reached']);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const identifier = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(value) ? value : null;
const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function providerError(error: unknown, signal: AbortSignal, deadline: AbortSignal): AppError {
  if (deadline.aborted) return new AppError('provider_timeout', 504);
  if (signal.aborted) return new AppError('provider_aborted', 409);
  if (error instanceof AppError) return error;
  const data = object(error); const nested = object(data.error);
  const status = typeof data.status === 'number' ? data.status : 0;
  const code = typeof data.code === 'string' ? data.code : nested.code;
  const name = error instanceof Error && error.name === 'Error' ? error.constructor.name : data.name;
  if (status === 401) return new AppError('provider_authentication_failed', 401);
  if (status === 403) return new AppError('provider_permission_denied', 403);
  if (status === 404 || code === 'model_not_found') return new AppError('provider_model_unavailable', 404);
  if (QUOTA_CODES.has(String(code)) || data.type === 'insufficient_quota' || nested.type === 'insufficient_quota') return new AppError('provider_quota_exceeded', 429);
  if (status === 429) return new AppError('provider_rate_limited', 429);
  if (status === 400 || status === 422) return new AppError('provider_invalid_request', status);
  if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError' || code === 'ETIMEDOUT') return new AppError('provider_timeout', 504);
  if (name === 'AbortError' || name === 'APIUserAbortError') return new AppError('provider_aborted', 409);
  if (name === 'APIConnectionError') return new AppError('provider_connection_error', 503);
  return new AppError('provider_unavailable', status >= 500 && status <= 599 ? status : 503);
}

/** Enforce our deadline even if an injected transport ignores AbortSignal.
 * A late transport rejection is still consumed; no retry is started. */
async function abortable<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new AppError('provider_aborted', 409));
    signal.addEventListener('abort', aborted, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

/** Real OpenAI embedding adapter. Only approved canonical projections belong
 * here; callers must never pass raw dialogue. API contract: dimensions and
 * encoding_format=float, with no Responses-only store parameter.
 * https://developers.openai.com/api/reference/resources/embeddings/methods/create */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly mode = 'real' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly timeoutMs: number;
  private readonly client: OpenAIEmbeddingTransport;
  private readonly events: OpenAIEmbeddingTelemetry[] = [];
  private sequence = 0;

  constructor(options: OpenAIEmbeddingProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!identifier(this.model)) throw new AppError('invalid_embedding_model', 503);
    if (!Number.isSafeInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > 3072
      || this.model === 'text-embedding-3-small' && this.dimensions > 1536) throw new AppError('invalid_embedding_dimensions', 503);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new AppError('invalid_embedding_timeout', 503);
    if (!options.client && !options.apiKey?.trim()) throw new AppError('missing_openai_key', 503);
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 0,
      timeout: this.timeoutMs, logLevel: 'off' }) as unknown as OpenAIEmbeddingTransport;
  }

  /** Content-free metadata only; callers cannot mutate retained events. */
  get telemetry(): readonly Readonly<OpenAIEmbeddingTelemetry>[] { return this.events.map(event => ({ ...event })); }
  get requestCount(): number { return this.sequence; }
  drainTelemetry(): OpenAIEmbeddingTelemetry[] { return this.events.splice(0).map(event => ({ ...event })); }

  async embed(inputs: readonly string[], externalSignal?: AbortSignal): Promise<EmbeddingResult> {
    if (externalSignal?.aborted) throw new AppError('provider_aborted', 409);
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > EMBEDDING_MAX_BATCH) throw new AppError('embedding_invalid_batch', 400);
    for (const text of inputs) if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > EMBEDDING_MAX_INPUT_BYTES) throw new AppError('embedding_invalid_input', 400);
    const input = [...inputs];
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, deadline.signal]) : deadline.signal;
    const event: OpenAIEmbeddingTelemetry = { sequence: ++this.sequence, api: 'embeddings', requestedModel: this.model,
      returnedModel: null, dimensions: this.dimensions, batchSize: input.length, requestId: null,
      startedAt: new Date().toISOString(), elapsedMs: 0, outcome: 'failed', promptTokens: null, totalTokens: null,
      errorCode: null, httpStatus: null };
    this.events.push(event);
    if (this.events.length > 1_000) this.events.shift();
    try {
      const response = await abortable(this.client.embeddings.create({ input, model: this.model,
        dimensions: this.dimensions, encoding_format: 'float' }, { signal, timeout: this.timeoutMs, maxRetries: 0 }), signal);
      if (signal.aborted) throw new AppError('provider_aborted', 409);
      const result = object(response); const usage = object(result.usage);
      event.httpStatus = 200; event.requestId = identifier(result._request_id); event.returnedModel = identifier(result.model);
      event.promptTokens = tokenCount(usage.prompt_tokens) ? usage.prompt_tokens : null;
      event.totalTokens = tokenCount(usage.total_tokens) ? usage.total_tokens : null;
      if (event.returnedModel !== this.model) throw new AppError('embedding_model_mismatch', 502);
      if (result.object !== 'list' || !Array.isArray(result.data) || result.data.length !== input.length
        || !tokenCount(usage.prompt_tokens) || !tokenCount(usage.total_tokens) || usage.total_tokens < usage.prompt_tokens) throw new AppError('embedding_invalid_response', 502);
      const vectors: number[][] = new Array(input.length);
      const seen = new Set<number>();
      for (const item of result.data) {
        const row = object(item); const index = row.index; const vector = row.embedding;
        if (row.object !== 'embedding' || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= input.length
          || seen.has(index) || !Array.isArray(vector) || vector.length !== this.dimensions
          || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new AppError('embedding_invalid_response', 502);
        const magnitude = Math.hypot(...vector);
        if (!Number.isFinite(magnitude) || magnitude <= 0) throw new AppError('embedding_invalid_response', 502);
        seen.add(index); vectors[index] = [...vector];
      }
      event.outcome = 'completed';
      return { vectors, model: this.model, dimensions: this.dimensions,
        usage: { promptTokens: usage.prompt_tokens, totalTokens: usage.total_tokens }, requestId: event.requestId,
        elapsedMs: performance.now() - started };
    } catch (error) {
      const failure = providerError(error, signal, deadline.signal);
      event.requestId ??= identifier(object(error).request_id) ?? identifier(object(error)._request_id);
      event.errorCode = failure.code; event.httpStatus ??= failure.status;
      throw failure;
    } finally { clearTimeout(timer); event.elapsedMs = performance.now() - started; }
  }
}
