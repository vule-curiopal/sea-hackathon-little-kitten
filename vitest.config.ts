import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['backend/pipeline/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'], testTimeout: 15000 },
  resolve: { alias: { '@miu/voice-contracts': new URL('./packages/voice-contracts/src/index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') } },
});
