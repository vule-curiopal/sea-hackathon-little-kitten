import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSsh } from '../../integration/ssh.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

const environment = { SSH_HOST: 'example.invalid', SSH_USER: 'miu', SSH_PASSWORD: 'unit-test-password-only' };
const arguments_ = ['-f', '-N', '-L', '127.0.0.1:15432:127.0.0.1:5432'];
function child() {
  return Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null, kill: vi.fn(), unref: vi.fn() });
}

describe.skipIf(process.platform !== 'win32')('Windows SSH forward ownership (offline lifecycle checks)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('keeps authentication helpers alive until readiness and leaves the successful forward running', async () => {
    const transport = child();
    spawn.mockReturnValue(transport);
    let ready!: () => void;
    const readiness = new Promise<void>(resolve => { ready = resolve; });
    const result = executeSsh(environment, arguments_, { backgroundReady: () => readiness, timeoutMs: 2000 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe('ssh');
    expect(args).not.toContain('-f');
    expect(args).toContain('-N');
    expect(JSON.stringify(args)).not.toContain(environment.SSH_PASSWORD);
    expect(options).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' });
    await access(options.env.SSH_ASKPASS);
    ready();
    expect(await result).toEqual({ stdout: '', stderr: '' });
    expect(transport.unref).toHaveBeenCalledOnce();
    expect(transport.kill).not.toHaveBeenCalled();
    await expect(access(options.env.SSH_ASKPASS)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts readiness and removes helpers when SSH fails before the tunnel is ready', async () => {
    const transport = child();
    spawn.mockReturnValue(transport);
    let signal!: AbortSignal;
    const result = executeSsh(environment, arguments_, { timeoutMs: 2000, backgroundReady: value => {
      signal = value;
      return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(value.reason), { once: true }));
    } });
    const rejected = expect(result).rejects.toMatchObject({ code: 'ssh_remote_failed', exitCode: 255 });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    transport.emit('close', 255);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(transport.kill).toHaveBeenCalledOnce();
    expect(transport.unref).not.toHaveBeenCalled();
    await expect(access(spawn.mock.calls[0]![2].env.SSH_ASKPASS)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
