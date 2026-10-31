import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../shared/types.js';
import { DEFAULT_EMBEDDING_DIMENSIONS, EMBEDDING_MAX_INPUT_BYTES, OpenAIEmbeddingProvider,
  type OpenAIEmbeddingTransport } from './embeddings.js';

// Offline transport/validation contracts only. No provider request, semantic
// vector, character/memory-quality result, or production connection is made.
const response = () => ({ object: 'list', model: 'text-embedding-3-small', _request_id: 'req_contract_only',
  data: [{ object: 'embedding', index: 0, embedding: [.6, .8, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
function transport(value: unknown = response()) {
  const calls: Array<{ body: Parameters<OpenAIEmbeddingTransport['embeddings']['create']>[0];
    options: Parameters<OpenAIEmbeddingTransport['embeddings']['create']>[1] }> = [];
  const client: OpenAIEmbeddingTransport = { embeddings: { create: async (body, options) => {
    calls.push({ body, options }); return value;
  } } };
  return { client, calls };
}
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('offline embedding request contract: float, configured shape, no store/user/tools, and zero retries', async () => {
  const mock = transport(); const provider = new OpenAIEmbeddingProvider({ client: mock.client, dimensions: 3 });
  const result = await provider.embed(['Pet: Mochi']);
  assert.deepEqual(mock.calls[0]!.body, { input: ['Pet: Mochi'], model: 'text-embedding-3-small', dimensions: 3, encoding_format: 'float' });
  assert.equal(mock.calls[0]!.options.maxRetries, 0);
  assert.equal(mock.calls[0]!.options.timeout, 10_000);
  assert.ok(mock.calls[0]!.options.signal instanceof AbortSignal);
  assert.deepEqual(result.vectors, [[.6, .8, 0]]);
  assert.deepEqual(result.usage, { promptTokens: 4, totalTokens: 4 });
  assert.equal(result.model, provider.model); assert.equal(result.dimensions, provider.dimensions);
  assert.equal(result.requestId, 'req_contract_only'); assert.ok(result.elapsedMs >= 0);
});

test('offline batch contract restores input order from distinct response indices and copies vectors', async () => {
  const value = response(); value.data.push({ object: 'embedding', index: 1, embedding: [0, 1, 0] }); value.data.reverse();
  const provider = new OpenAIEmbeddingProvider({ client: transport(value).client, dimensions: 3 });
  const result = await provider.embed(['Pet: Mochi', 'Hobby: drawing']);
  assert.deepEqual(result.vectors, [[.6, .8, 0], [0, 1, 0]]);
  result.vectors[0]![0] = 9;
  assert.equal(value.data.find(row => row.index === 0)!.embedding[0], .6);
});

test('offline configuration contracts reject absent key, invalid dimensions/model/timeout', () => {
  const client = transport().client;
  assert.equal(new OpenAIEmbeddingProvider({ client }).dimensions, DEFAULT_EMBEDDING_DIMENSIONS);
  assert.throws(() => new OpenAIEmbeddingProvider(), hasCode('missing_openai_key'));
  assert.throws(() => new OpenAIEmbeddingProvider({ client, model: 'bad model\n' }), hasCode('invalid_embedding_model'));
  for (const dimensions of [0, -1, 1.5, NaN, 1537]) assert.throws(() => new OpenAIEmbeddingProvider({ client, dimensions }), hasCode('invalid_embedding_dimensions'));
  for (const timeoutMs of [0, -1, 1.5, Infinity, 120_001]) assert.throws(() => new OpenAIEmbeddingProvider({ client, timeoutMs }), hasCode('invalid_embedding_timeout'));
});

test('offline input contracts reject empty/oversized batches and enforce UTF-8 bytes before transport', async () => {
  const mock = transport(); const provider = new OpenAIEmbeddingProvider({ client: mock.client, dimensions: 3 });
  for (const batch of [[], Array.from({ length: 33 }, () => 'a')]) await assert.rejects(() => provider.embed(batch), hasCode('embedding_invalid_batch'));
  for (const batch of [[''], ['  '], ['a'.repeat(EMBEDDING_MAX_INPUT_BYTES + 1)], ['ấ'.repeat(171)]]) await assert.rejects(() => provider.embed(batch), hasCode('embedding_invalid_input'));
  assert.equal(mock.calls.length, 0); assert.equal(provider.requestCount, 0); assert.equal(provider.telemetry.length, 0);
  await provider.embed(['a'.repeat(EMBEDDING_MAX_INPUT_BYTES)]);
  assert.equal(mock.calls.length, 1);
});

test('offline response contracts reject malformed count/index/shape/value/usage/model without retry', async t => {
  const malformed: Array<[string, (value: ReturnType<typeof response>) => void, string?]> = [
    ['missing data', value => { value.data = []; }],
    ['duplicate index', value => { value.data.push({ ...value.data[0]! }); }],
    ['out of range index', value => { value.data[0]!.index = 1; }],
    ['fractional index', value => { value.data[0]!.index = .5; }],
    ['wrong dimensions', value => { value.data[0]!.embedding = [1, 0]; }],
    ['zero vector', value => { value.data[0]!.embedding = [0, 0, 0]; }],
    ['nonfinite component', value => { value.data[0]!.embedding[0] = Infinity; }],
    ['nonfinite norm', value => { value.data[0]!.embedding = [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]; }],
    ['invalid tokens', value => { value.usage.prompt_tokens = -1; }],
    ['inconsistent tokens', value => { value.usage.total_tokens = 0; }],
    ['different model', value => { value.model = 'text-embedding-3-large'; }, 'embedding_model_mismatch'],
  ];
  for (const [name, mutate, expected = 'embedding_invalid_response'] of malformed) await t.test(name, async () => {
    const value = response(); mutate(value); const mock = transport(value);
    const provider = new OpenAIEmbeddingProvider({ client: mock.client, dimensions: 3 });
    await assert.rejects(() => provider.embed(['Pet: Mochi']), hasCode(expected));
    assert.equal(mock.calls.length, 1); assert.equal(provider.telemetry[0]!.outcome, 'failed');
  });
  const duplicate = response(); duplicate.data.push({ ...duplicate.data[0]! });
  const provider = new OpenAIEmbeddingProvider({ client: transport(duplicate).client, dimensions: 3 });
  await assert.rejects(() => provider.embed(['a', 'b']), hasCode('embedding_invalid_response'));
});

test('offline API failures retain safe status/category/request ID and never error text or automatic retries', async t => {
  const failures = [
    [{ status: 401 }, 'provider_authentication_failed'], [{ status: 403 }, 'provider_permission_denied'],
    [{ status: 404 }, 'provider_model_unavailable'], [{ status: 429, code: 'credit_balance_exhausted' }, 'provider_quota_exceeded'],
    [{ status: 429, error: { type: 'insufficient_quota' } }, 'provider_quota_exceeded'],
    [{ status: 429 }, 'provider_rate_limited'], [{ status: 400 }, 'provider_invalid_request'],
  ] as const;
  for (const [metadata, expected] of failures) await t.test(expected, async () => {
    let attempts = 0;
    const client: OpenAIEmbeddingTransport = { embeddings: { create: async () => {
      attempts++; throw Object.assign(new Error('untrusted provider detail'), metadata, { request_id: 'req_contract_failure' });
    } } };
    const provider = new OpenAIEmbeddingProvider({ client, dimensions: 3 });
    await assert.rejects(() => provider.embed(['Pet: Mochi']), error => {
      assert.ok(hasCode(expected)(error)); assert.equal((error as Error).message, expected); return true;
    });
    assert.equal(attempts, 1); assert.equal(provider.telemetry[0]!.requestId, 'req_contract_failure');
    assert.equal(JSON.stringify(provider.telemetry).includes('untrusted provider detail'), false);
  });
});

test('offline cancellation contracts: already aborted sends no request; in-flight abort discards late output', async () => {
  const mock = transport(); const provider = new OpenAIEmbeddingProvider({ client: mock.client, dimensions: 3 });
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(() => provider.embed(['a'], stopped.signal), hasCode('provider_aborted'));
  assert.equal(mock.calls.length, 0);
  let resolveLate!: (value: unknown) => void;
  const client: OpenAIEmbeddingTransport = { embeddings: { create: async () => new Promise(resolve => { resolveLate = resolve; }) } };
  const inFlight = new OpenAIEmbeddingProvider({ client, dimensions: 3 }); const controller = new AbortController();
  const pending = inFlight.embed(['a'], controller.signal); controller.abort();
  await assert.rejects(() => pending, hasCode('provider_aborted'));
  resolveLate(response()); await Promise.resolve();
  assert.equal(inFlight.telemetry[0]!.outcome, 'failed'); assert.equal(inFlight.telemetry[0]!.errorCode, 'provider_aborted');
});

test('offline deadline contract rejects a noncooperating transport without another request', async () => {
  let attempts = 0;
  const client: OpenAIEmbeddingTransport = { embeddings: { create: async () => { attempts++; return new Promise(() => {}); } } };
  const provider = new OpenAIEmbeddingProvider({ client, dimensions: 3, timeoutMs: 10 });
  await assert.rejects(() => provider.embed(['a']), hasCode('provider_timeout'));
  assert.equal(attempts, 1); assert.equal(provider.telemetry[0]!.errorCode, 'provider_timeout');
});

test('offline telemetry contract contains metadata only and returns immutable copies', async () => {
  const provider = new OpenAIEmbeddingProvider({ client: transport().client, dimensions: 3 });
  await provider.embed(['Pet: Mochi']);
  const event = provider.telemetry[0]!;
  assert.deepEqual(Object.keys(event).sort(), ['sequence', 'api', 'requestedModel', 'returnedModel', 'dimensions', 'batchSize', 'requestId',
    'startedAt', 'elapsedMs', 'outcome', 'promptTokens', 'totalTokens', 'errorCode', 'httpStatus'].sort());
  assert.equal(JSON.stringify(event).includes('Mochi'), false);
  (event as { sequence: number }).sequence = 900;
  assert.equal(provider.telemetry[0]!.sequence, 1);
  assert.equal(provider.drainTelemetry().length, 1); assert.equal(provider.telemetry.length, 0); assert.equal(provider.requestCount, 1);
});
