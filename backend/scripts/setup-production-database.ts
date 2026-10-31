import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRemoteCommand, type SshEnvironment } from '../integration/ssh.js';
import { ensureDatabaseTunnel } from './database-tunnel.js';

const MARKER = 'miu-character-memory/shoppee-hackathon';
const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]{2,62}$/u.test(value)) throw new Error('invalid_database_identifier');
  return value;
};
const literal = (value: string): string => "'" + value.replaceAll("'", "''") + "'";

async function updateExistingEnvironment(path: string, values: Record<string, string>): Promise<void> {
  // Read immediately before replacing only the requested keys, preserving every
  // unrelated credential and comment. Never create a second credential file.
  let source = await readFile(path, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const expression = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'mu');
    source = expression.test(source) ? source.replace(expression, () => line) : source.replace(/\n?$/u, '\n') + line + '\n';
  }
  const temporary = path + '.miu-update-' + randomBytes(8).toString('hex');
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

export async function setupProductionDatabase(environment: SshEnvironment = process.env, envPath = resolve(environment.MIU_ENV_FILE ?? '.env')) {
  const database = identifier(environment.DATABASE_NAME ?? 'miu_character_memory');
  const role = identifier(environment.DATABASE_USER ?? 'miu_character_memory_app');
  const localPort = Number(environment.DATABASE_SSH_LOCAL_PORT ?? 15_432);
  const remotePort = Number(environment.DATABASE_SSH_REMOTE_PORT ?? 5_432);
  if (![localPort, remotePort].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65_535)) throw new Error('invalid_database_tunnel_port');
  let password = randomBytes(32).toString('hex');
  if (environment.DATABASE_URL) {
    const previous = new URL(environment.DATABASE_URL);
    if (decodeURIComponent(previous.username) === role && decodeURIComponent(previous.pathname.slice(1)) === database && previous.password) password = decodeURIComponent(previous.password);
  }
  // Only the isolated, explicitly marked role/database can be reused. Existing
  // unrelated names cause a failure before any role credentials are changed.
  const sql = `DO $miu$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_database WHERE datname=${literal(database)} AND
   (COALESCE(shobj_description(oid,'pg_database'),'') <> ${literal(MARKER)} OR pg_get_userbyid(datdba) <> ${literal(role)})) THEN
   RAISE EXCEPTION 'miu_database_name_conflict';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${literal(role)} AND COALESCE(shobj_description(oid,'pg_authid'),'') <> ${literal(MARKER)}) THEN
   RAISE EXCEPTION 'miu_role_name_conflict';
 END IF;
END $miu$;
SELECT 'CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT CONNECTION LIMIT 25'
 WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(role)})
\\gexec
ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT CONNECTION LIMIT 25 PASSWORD ${literal(password)};
COMMENT ON ROLE ${role} IS ${literal(MARKER)};
SELECT 'CREATE DATABASE ${database} OWNER ${role} ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=${literal(database)})
\\gexec
COMMENT ON DATABASE ${database} IS ${literal(MARKER)};
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT,TEMPORARY ON DATABASE ${database} TO ${role};
SELECT 'miu_database_ready';
`;
  const remote = await runRemoteCommand(environment, `set -eu\ncd /tmp\ncommand -v psql >/dev/null\nsudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -p ${remotePort} <<'MIU_SQL'\n${sql}MIU_SQL\n`, 60_000);
  if (!remote.stdout.includes('miu_database_ready')) throw new Error('database_setup_failed');
  const databaseUrl = `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${localPort}/${database}`;
  const values = {
    DATABASE_URL: databaseUrl,
    DATABASE_NAME: database,
    DATABASE_USER: role,
    DATABASE_SSH_TUNNEL: 'true',
    DATABASE_SSH_LOCAL_PORT: String(localPort),
    DATABASE_SSH_REMOTE_PORT: String(remotePort),
    MIU_PROVIDER: 'real',
  };
  // Database provisioning preserves the existing speech-provider logging choice.
  // Integrated startup supplies its own disabled default when no choice exists.
  // Persist the generated credential before connecting, so a transport failure
  // can be retried without losing the dedicated role's password.
  await updateExistingEnvironment(envPath, values);
  const configured = { ...environment, ...values, MIU_ENV_FILE: envPath };
  const tunnel = await ensureDatabaseTunnel(configured);
  return { database, role, driver: 'postgresql' as const, tunnel, isolated: true, existingServicesPreserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const envPath = resolve(process.env.MIU_ENV_FILE ?? '.env');
    loadEnvFile(envPath);
    const result = await setupProductionDatabase(process.env, envPath);
    process.stdout.write(JSON.stringify({ operation: 'production_database_ready', ...result }, null, 2) + '\n');
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : 'production_database_setup_failed';
    process.stderr.write('Production database setup failed: ' + code + '.\n');
    process.exitCode = 1;
  }
}
