import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server-runtime.js';

describe('loopback reverse proxy configuration', () => {
  it('defaults to disabled and accepts only explicit boolean values', () => {
    expect(loadConfig({}).trustProxyLoopback).toBe(false);
    expect(loadConfig({ TRUST_PROXY_LOOPBACK: 'false' }).trustProxyLoopback).toBe(false);
    expect(loadConfig({ TRUST_PROXY_LOOPBACK: 'true' }).trustProxyLoopback).toBe(true);
    expect(() => loadConfig({ TRUST_PROXY_LOOPBACK: 'yes' })).toThrow('TRUST_PROXY_LOOPBACK must be true or false');
    expect(() => loadConfig({ TRUST_PROXY_LOOPBACK: '' })).toThrow('TRUST_PROXY_LOOPBACK must be true or false');
  });

  it('uses separate client rate-limit buckets behind a trusted localhost proxy', async () => {
    const app = await buildApp({ config: loadConfig({ MIU_PROVIDER: 'fake', TRUST_PROXY_LOOPBACK: 'true' }) });
    const server = createServer(app);
    try {
      const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
      const trustProxy = app.get('trust proxy fn') as (address: string, hop: number) => boolean;
      expect(trustProxy('127.0.0.1', 0)).toBe(true);
      expect(trustProxy('::1', 0)).toBe(true);
      expect(trustProxy('203.0.113.10', 0)).toBe(false);
      expect(trustProxy('2001:db8::1', 0)).toBe(false);

      const remaining = [];
      for (const address of ['198.51.100.10', '198.51.100.10', '198.51.100.20']) {
        const response = await fetch(`${baseUrl}/api/health`, { headers: { 'X-Forwarded-For': address } });
        expect(response.status).toBe(200);
        const rateLimit = response.headers.get('ratelimit');
        expect(rateLimit).not.toBeNull();
        const match = rateLimit?.match(/;\s*r=(\d+)/u);
        expect(match).not.toBeNull();
        remaining.push(Number(match![1]));
        await response.json();
      }
      expect(remaining).toEqual([59, 58, 59]);
    } finally {
      await server.close();
    }
  });
});
