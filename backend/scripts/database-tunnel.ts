import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { executeSsh, type SshEnvironment } from '../integration/ssh.js';

export interface DatabaseTunnelResult {
  enabled: boolean;
  started: boolean;
  host?: string;
  port?: number;
  remotePort?: number;
}

function port(value: string | undefined, fallback: number): number {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < 1 || result > 65_535) throw new Error('invalid_database_tunnel_port');
  return result;
}

async function listening(host: string, targetPort: number): Promise<boolean> {
  return new Promise(resolveListening => {
    const socket = createConnection({ host, port: targetPort });
    const done = (result: boolean) => { socket.destroy(); resolveListening(result); };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function verifyTarget(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 7_000 });
  try {
    const result = await pool.query<{ database: string; role: string }>('SELECT current_database() AS database,current_user AS role');
    if (result.rows[0]?.database !== decodeURIComponent(target.pathname.slice(1)) || result.rows[0]?.role !== decodeURIComponent(target.username)) throw new Error('database_tunnel_target_mismatch');
  } catch { throw new Error('database_tunnel_target_unavailable'); }
  finally { await pool.end(); }
}

const pending = new Map<string, Promise<DatabaseTunnelResult>>();

/** A local SSH daemon owns the forward so CLI commands and the server share it.
 * PostgreSQL remains bound to the remote host's loopback interface. */
export async function ensureDatabaseTunnel(environment: SshEnvironment = process.env): Promise<DatabaseTunnelResult> {
  if (environment.DATABASE_SSH_TUNNEL !== 'true') return { enabled: false, started: false };
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error('missing_database_url');
  const target = new URL(databaseUrl);
  const localPort = port(environment.DATABASE_SSH_LOCAL_PORT ?? target.port, 15_432);
  const remotePort = port(environment.DATABASE_SSH_REMOTE_PORT, 5_432);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1'
    || Number(target.port || 5432) !== localPort || !target.username || !target.password || target.pathname.length < 2) throw new Error('invalid_database_tunnel_target');
  const key = `${environment.SSH_HOST}:${environment.SSH_PORT ?? 22}:${localPort}:${remotePort}`;
  const previous = pending.get(key);
  if (previous) return previous;
  const work = (async () => {
    const result = { enabled: true, host: '127.0.0.1', port: localPort, remotePort };
    if (await listening('127.0.0.1', localPort)) {
      await verifyTarget(databaseUrl);
      return { ...result, started: false };
    }
    await executeSsh(environment, ['-f', '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`], {
      timeoutMs: 30_000,
      backgroundReady: async signal => {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          if (await listening('127.0.0.1', localPort)) { await verifyTarget(databaseUrl); return; }
          await delay(100, undefined, { signal });
        }
        throw new Error('database_tunnel_not_ready');
      },
    });
    await verifyTarget(databaseUrl);
    return { ...result, started: true };
  })();
  pending.set(key, work);
  try { return await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    loadEnvFile(process.env.MIU_ENV_FILE ?? '.env');
    const result = await ensureDatabaseTunnel(process.env);
    process.stdout.write(JSON.stringify({ operation: 'database_tunnel', ...result }) + '\n');
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : 'database_tunnel_failed';
    process.stderr.write('Database tunnel failed: ' + code + '.\n');
    process.exitCode = 1;
  }
}
