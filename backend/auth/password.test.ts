import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../shared/types.js';
import { hashPassword, hashSeedPassword, PASSWORD_KDF_LIMITS, SCRYPT_PARAMETERS, validatePassword, verifyPassword } from './password.js';

// Offline cryptographic/input/resource-boundary contracts. No character engine,
// provider, model request, or behavioral evaluation is involved.
test('password policy counts Unicode codepoints and preserves spaces and null bytes', async () => {
  for (const valid of ['🚀'.repeat(12), '🚀'.repeat(128), '  mèo🚀 password\0 ']) assert.doesNotThrow(() => validatePassword(valid));
  for (const invalid of [undefined, 123, '', '🚀'.repeat(11), '🚀'.repeat(129), 'a'.repeat(129), 'a'.repeat(11) + '\uD800']) {
    assert.throws(() => validatePassword(invalid), error => error instanceof AppError && error.code === 'invalid_password');
  }
  const password = '  mèo🚀 password\0 ';
  const encoded = await hashPassword(password);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword(password.trim(), encoded), false);
  assert.equal(await verifyPassword(password.replace('\0', ''), encoded), false);
});

test('scrypt hashes have distinct salts, versioned fixed parameters, and constant-size derived keys', async () => {
  const password = 'a sufficiently long password';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^\$scrypt\$v=1\$N=32768,r=8,p=3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/u);
  assert.equal(SCRYPT_PARAMETERS.N, 32_768);
  assert.equal(SCRYPT_PARAMETERS.maxmem, 64 * 1024 * 1024);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('a different long password', first), false);
});

test('unsupported stored versions, resource parameters, and malformed hashes never authenticate', async () => {
  const password = 'a sufficiently long password';
  const encoded = await hashPassword(password);
  for (const invalid of [undefined, '', encoded.replace('v=1', 'v=99'), encoded.replace('N=32768', 'N=999999999'), encoded + '=', encoded.slice(0, -3)]) {
    assert.equal(await verifyPassword(password, invalid), false);
  }
});

test('only explicit test seeding can hash a short password; verification supports its stored credential', async () => {
  await assert.rejects(hashPassword('1'), error => error instanceof AppError && error.code === 'invalid_password');
  const encoded = await hashSeedPassword('1');
  assert.equal(await verifyPassword('1', encoded), true);
  assert.equal(await verifyPassword('2', encoded), false);
  await assert.rejects(hashSeedPassword(''), /invalid_password/u);
});

test('password KDFs bound active work and queued requests, then release their slots', async () => {
  const requests = Array.from({ length: PASSWORD_KDF_LIMITS.active + PASSWORD_KDF_LIMITS.queued + 1 }, () => hashPassword('resource boundary password'));
  const results = await Promise.allSettled(requests);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.status === 'rejected' && rejected[0].reason instanceof AppError && rejected[0].reason.code === 'auth_busy');
  assert.equal(results.filter(result => result.status === 'fulfilled').length, PASSWORD_KDF_LIMITS.active + PASSWORD_KDF_LIMITS.queued);
  assert.match(await hashPassword('slots are released password'), /^\$scrypt\$/u);
});
