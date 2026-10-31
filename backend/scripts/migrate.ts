import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createMemoryStore } from '../memory/index.js';
import { ensureDatabaseTunnel } from './database-tunnel.js';

async function main() {
  const envPath = process.env.MIU_ENV_FILE ?? '.env';
  if (existsSync(envPath)) loadEnvFile(envPath);
  await ensureDatabaseTunnel(process.env);
  const store = await createMemoryStore({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.DATABASE_URL ? undefined : process.env.MIU_DATA_DIR ?? '.miu-data' });
  try { process.stdout.write('Miu PostgreSQL migrations applied.\n'); }
  finally { await store.close(); }
}

main().catch((error: unknown) => {
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? String(error.code)
    : error instanceof Error ? error.message : '';
  const code = /^[a-zA-Z0-9_]+$/u.test(candidate) ? candidate : 'migration_failed';
  process.stderr.write('Database migration failed: ' + code + '.\n');
  process.exitCode = 1;
});
