import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withSshAskpass } from './ssh.js';

test('SSH authentication helpers handle Windows paths without writing a password into scripts', async () => {
  let directory = '';
  await withSshAskpass({ SSH_PASSWORD: 'unit-test-password-only' }, async environment => {
    directory = dirname(environment.SSH_ASKPASS!);
    const script = await readFile(environment.MIU_SSH_ASKPASS_SCRIPT!, 'utf8');
    assert.ok(script.includes('process.env.SSH_PASSWORD'));
    assert.ok(!script.includes('unit-test-password-only'));
    assert.equal(environment.SSH_PASSWORD, 'unit-test-password-only');
    assert.equal(environment.MIU_SSH_NODE, process.execPath);
    if (process.platform === 'win32') {
      const launcher = await readFile(environment.SSH_ASKPASS!, 'utf8');
      assert.ok(launcher.includes('"%MIU_SSH_NODE%" "%MIU_SSH_ASKPASS_SCRIPT%"'));
      assert.ok(!launcher.includes('unit-test-password-only'));
      assert.ok(environment.SSH_ASKPASS!.endsWith('.cmd'));
    }
  });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('SSH helpers are removed when the transport fails', async () => {
  let directory = '';
  const failure = new Error('unit transport failure');
  await assert.rejects(withSshAskpass({ SSH_PASSWORD: 'unit-test-password-only' }, async environment => {
    directory = dirname(environment.SSH_ASKPASS!);
    throw failure;
  }), error => error === failure);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
