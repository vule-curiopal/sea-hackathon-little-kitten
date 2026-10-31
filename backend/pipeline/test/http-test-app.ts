import supertest from 'supertest';
import { buildApp } from '../src/app.js';
import { createServer } from '../src/server-runtime.js';

/** Real ephemeral HTTP listener, with deterministic disposal owned by each test. */
export async function createTestApp(options: Parameters<typeof buildApp>[0] = {}) {
  const runtime = createServer(await buildApp(options));
  const baseUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
  return { runtime, baseUrl, http: supertest(baseUrl) };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
