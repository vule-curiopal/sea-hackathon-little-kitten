import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, migrate } from '../memory/database.js';
import { importConversationHistory, loadConversationHistory, verifyConversationHistory } from '../memory/import-history.js';
import { ensureDatabaseTunnel } from './database-tunnel.js';

function options(args: string[]) {
  let source = fileURLToPath(new URL('../fixtures/conversations/generated/', import.meta.url));
  let dataDir: string | undefined;
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--check') { check = true; continue; }
    if (argument === '--source' || argument === '--data-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('invalid_options');
      if (argument === '--source') source = resolve(value);
      else dataDir = resolve(value);
    } else throw new Error('invalid_options');
  }
  return { source, dataDir, check };
}

async function main() {
  const args = options(process.argv.slice(2));
  const envPath = process.env.MIU_ENV_FILE ?? '.env';
  if (existsSync(envPath)) loadEnvFile(envPath);
  const databaseUrl = args.dataDir ? undefined : process.env.DATABASE_URL || undefined;
  const dataDir = databaseUrl ? undefined : args.dataDir ?? resolve(process.env.MIU_DATA_DIR || '.miu-data');

  // Parse and validate all source content before opening or changing storage.
  const history = await loadConversationHistory(args.source);
  if (args.check && dataDir && !existsSync(dataDir)) throw new Error('database_not_found');
  // An explicit local archive remains independent of remote database settings.
  // Other commands restore/verify the configured tunnel before connecting.
  if (!args.dataDir) await ensureDatabaseTunnel(process.env);
  const db = await createDatabase({ databaseUrl, dataDir });
  try {
    if (!args.check) await migrate(db);
    const result = args.check
      ? await verifyConversationHistory(db, history)
      : await importConversationHistory(db, history);
    process.stdout.write(JSON.stringify({
      operation: args.check ? 'verified' : 'imported',
      target: databaseUrl ? { driver: 'postgresql', database: new URL(databaseUrl).pathname.slice(1) } : { driver: 'pglite', directory: dataDir },
      ...result,
    }, null, 2) + '\n');
  } finally { await db.close(); }
}

main().catch((error: unknown) => {
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? String(error.code)
    : error instanceof Error ? error.message : '';
  const code = /^[a-zA-Z0-9_]+$/u.test(candidate) ? candidate : 'import_failed';
  process.stderr.write('Conversation history operation failed: ' + code + '.\n');
  process.exitCode = 1;
});
