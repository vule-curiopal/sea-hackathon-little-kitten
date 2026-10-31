import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type SshEnvironment = Readonly<Record<string, string | undefined>>;

export class SshError extends Error {
  constructor(readonly code: string, readonly exitCode?: number) { super(code); }
}

export function sshArguments(environment: SshEnvironment): string[] {
  const host = environment.SSH_HOST;
  const user = environment.SSH_USER;
  const port = Number(environment.SSH_PORT ?? 22);
  if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/u.test(host)
    || !user || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/u.test(user)
    || !environment.SSH_PASSWORD || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new SshError('invalid_ssh_configuration');
  return ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', '-p', String(port), '-l', user, host];
}

/** The password travels only through SSH's private askpass pipe, never argv/logs. */
export async function withSshAskpass<T>(environment: SshEnvironment, work: (childEnvironment: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'miu-ssh-'));
  const helper = join(directory, 'askpass.cjs');
  try {
    await writeFile(helper, `#!${process.execPath}\nconst {loadEnvFile}=require('node:process');\ntry { if(process.env.MIU_SSH_ENV_FILE) loadEnvFile(process.env.MIU_SSH_ENV_FILE); const password=process.env.SSH_PASSWORD; if(!password) process.exit(1); process.stdout.write(password+'\\n'); } catch { process.exit(1); }\n`, { mode: 0o700 });
    return await work({ ...process.env, ...environment, MIU_SSH_ENV_FILE: resolve(environment.MIU_ENV_FILE ?? '.env'),
      SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'miu:0' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function executeSsh(environment: SshEnvironment, extraArguments: string[], options: { input?: string; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  const args = sshArguments(environment);
  // Extra SSH flags must precede the target host. Remote commands follow it.
  const target = args.pop()!;
  return withSshAskpass(environment, childEnvironment => new Promise((resolveRun, reject) => {
    const child = spawn('ssh', [...args, ...extraArguments, target], { env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let outputBytes = 0; let rejected = false;
    const finishError = (code: string, exitCode?: number) => {
      if (rejected) return;
      rejected = true;
      child.kill('SIGTERM');
      reject(new SshError(code, exitCode));
    };
    const timer = setTimeout(() => finishError('ssh_timeout'), options.timeoutMs ?? 120_000);
    timer.unref();
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxOutputBytes ?? 128 * 1_024)) { finishError('ssh_output_limit'); return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.once('error', () => { clearTimeout(timer); finishError('ssh_unavailable'); });
    child.once('close', code => {
      clearTimeout(timer);
      if (rejected) return;
      if (code !== 0) { reject(new SshError('ssh_remote_failed', code ?? undefined)); return; }
      resolveRun({ stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  }));
}

export async function runRemoteCommand(environment: SshEnvironment, script: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  // The command is constant; the script (which may contain generated SQL
  // credentials) is delivered on encrypted stdin, never a process argument.
  const args = sshArguments(environment);
  return withSshAskpass(environment, childEnvironment => new Promise((resolveRun, reject) => {
    const child = spawn('ssh', [...args, 'bash -s'], { env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let bytes = 0; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGTERM'); reject(new SshError('ssh_timeout')); } }, timeoutMs);
    timer.unref();
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1_024) { child.kill('SIGTERM'); return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.once('error', () => { clearTimeout(timer); if (!done) { done = true; reject(new SshError('ssh_unavailable')); } });
    child.once('close', code => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (code !== 0) reject(new SshError('ssh_remote_failed', code ?? undefined));
      else resolveRun({ stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(script);
  }));
}
