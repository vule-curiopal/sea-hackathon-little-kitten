import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../shared/types.js';

// OWASP's scrypt 32 MiB option: N=2^15, r=8, p=3. Parameters are fixed and
// validated on reads; a stored hash can never request arbitrary KDF resources.
export const SCRYPT_PARAMETERS = Object.freeze({ N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024, saltBytes: 16, keyBytes: 64 });
export const PASSWORD_KDF_LIMITS = Object.freeze({ active: 2, queued: 8 });
const PREFIX = '$scrypt$v=1$N=32768,r=8,p=3$';
const HASH = /^\$scrypt\$v=1\$N=32768,r=8,p=3\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/u;
const dummySalt = randomBytes(SCRYPT_PARAMETERS.saltBytes);
const dummyKey = Buffer.alloc(SCRYPT_PARAMETERS.keyBytes);
let active = 0;
const queue: Array<() => void> = [];

function isPassword(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

export function validatePassword(value: unknown): asserts value is string {
  if (!isPassword(value)) throw new AppError('invalid_password', 400);
}

async function boundedKdf(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= PASSWORD_KDF_LIMITS.active) {
    if (queue.length >= PASSWORD_KDF_LIMITS.queued) throw new AppError('auth_busy', 503);
    await new Promise<void>(resolve => queue.push(resolve));
  } else active++;
  const input = Buffer.from(password, 'utf8');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(input, salt, SCRYPT_PARAMETERS.keyBytes, {
        N: SCRYPT_PARAMETERS.N, r: SCRYPT_PARAMETERS.r, p: SCRYPT_PARAMETERS.p, maxmem: SCRYPT_PARAMETERS.maxmem,
      }, (error, key) => error ? reject(new AppError('auth_busy', 503)) : resolve(key));
    });
  } finally {
    input.fill(0);
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

async function hash(value: unknown): Promise<string> {
  if (!isPassword(value)) throw new AppError('invalid_password', 400);
  const salt = randomBytes(SCRYPT_PARAMETERS.saltBytes);
  const key = await boundedKdf(value, salt);
  try { return `${PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}`; }
  finally { key.fill(0); }
}

export function hashPassword(value: unknown): Promise<string> { return hash(value); }

/** Demo bootstrap uses the same nonempty-string policy as public registration. */
export function hashSeedPassword(value: unknown): Promise<string> { return hash(value); }

function storedHash(value: unknown): { salt: Buffer; key: Buffer } | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = HASH.exec(value);
  if (!match) return null;
  const salt = Buffer.from(match[1]!, 'base64url');
  const key = Buffer.from(match[2]!, 'base64url');
  return salt.length === SCRYPT_PARAMETERS.saltBytes && key.length === SCRYPT_PARAMETERS.keyBytes
    && salt.toString('base64url') === match[1] && key.toString('base64url') === match[2] ? { salt, key } : null;
}

/** Unknown accounts and unsupported hashes still perform the same bounded
 * scrypt work. Password bytes are preserved without trimming. */
export async function verifyPassword(password: unknown, encoded: unknown): Promise<boolean> {
  const valid = isPassword(password);
  const parsed = storedHash(encoded);
  const actual = await boundedKdf(valid ? password : 'invalid-password-dummy-input', parsed?.salt ?? dummySalt);
  try {
    const matches = timingSafeEqual(actual, parsed?.key ?? dummyKey);
    return valid && parsed !== null && matches;
  } finally { actual.fill(0); }
}
