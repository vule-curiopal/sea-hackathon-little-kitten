import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MemoryStore } from '../memory/index.js';
import type { Queryable } from '../memory/database.js';
import { AppError } from '../shared/types.js';
import { hashPassword, hashSeedPassword, validatePassword, verifyPassword } from './password.js';

export type AuthUser = { id: string; username: string; profile_key: string };
export type AuthSession = { user: AuthUser; token: string; expiresAt: string };
export interface AuthStoreOptions { now?: () => Date }
export const AUTH_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
type AccountRow = AuthUser & { password_hash: string };
const userFields = 'a.id,a.username,p.demo_key AS profile_key';
const accountFrom = 'user_accounts a JOIN profiles p ON p.id=a.profile_id';
const user = (row: AuthUser): AuthUser => ({ id: String(row.id), username: String(row.username), profile_key: String(row.profile_key) });
const uniqueViolation = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === '23505';

export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new AppError('invalid_username', 400);
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_.-]{2,31}$/u.test(normalized)) throw new AppError('invalid_username', 400);
  return normalized;
}

function tokenHash(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) return null;
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

export class AuthStore {
  private readonly now: () => Date;
  constructor(private readonly memory: MemoryStore, options: AuthStoreOptions = {}) { this.now = options.now ?? (() => new Date()); }

  private async account(username: string): Promise<AccountRow | undefined> {
    return (await this.memory.db.query<AccountRow>(`SELECT ${userFields},a.password_hash FROM ${accountFrom} WHERE a.username=$1`, [username])).rows[0];
  }

  private session(currentUser: AuthUser): AuthSession & { hash: string; createdAt: string } {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    return { user: user(currentUser), token, hash: tokenHash(token)!, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + AUTH_SESSION_LIFETIME_MS).toISOString() };
  }

  private async saveSession(tx: Queryable, value: AuthSession & { hash: string; createdAt: string }): Promise<void> {
    await tx.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [value.hash, value.user.id, value.createdAt, value.expiresAt]);
  }

  async register(usernameInput: unknown, password: unknown): Promise<AuthSession> {
    const username = normalizeUsername(usernameInput);
    validatePassword(password);
    if (await this.account(username)) throw new AppError('username_in_use', 409);
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    const profileKey = `user_${id}`;
    const session = this.session({ id, username, profile_key: profileKey });
    let finalized = false;
    try {
      await this.memory.createProfile({ demoKey: profileKey, displayName: 'Friend', ageBand: '6-8', languageMode: 'vi', timezone: 'Asia/Ho_Chi_Minh' }, async (tx, profile) => {
        await tx.query('INSERT INTO user_accounts(id,username,password_hash,profile_id,created_at) VALUES($1,$2,$3,$4,$5)', [id, username, passwordHash, profile.id, session.createdAt]);
        await this.saveSession(tx, session);
        finalized = true;
      });
    } catch (error) {
      if (uniqueViolation(error)) throw new AppError('username_in_use', 409);
      throw error;
    }
    if (!finalized) throw new AppError('auth_busy', 503);
    return { user: session.user, token: session.token, expiresAt: session.expiresAt };
  }

  async login(usernameInput: unknown, password: unknown): Promise<AuthSession> {
    let username: string | null = null;
    try { username = normalizeUsername(usernameInput); } catch { /* Login failures use one credential error. */ }
    const account = username === null ? undefined : await this.account(username);
    const matches = await verifyPassword(password, account?.password_hash);
    if (!account || !matches) throw new AppError('invalid_credentials', 401);
    const session = this.session(account);
    await this.saveSession(this.memory.db, session);
    return { user: session.user, token: session.token, expiresAt: session.expiresAt };
  }

  async authenticate(token: unknown): Promise<AuthUser | null> {
    const hash = tokenHash(token);
    if (!hash) return null;
    const row = (await this.memory.db.query<AuthUser>(`SELECT ${userFields} FROM auth_sessions s JOIN user_accounts a ON a.id=s.user_id JOIN profiles p ON p.id=a.profile_id WHERE s.token_hash=$1 AND s.expires_at>$2`, [hash, this.now().toISOString()])).rows[0];
    return row ? user(row) : null;
  }

  async revoke(token: unknown): Promise<void> {
    const hash = tokenHash(token);
    if (hash) await this.memory.db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash]);
  }

  /** Explicit demo bootstrap only. Existing accounts keep their password and
   * profile; a seed never silently takes ownership of another account. */
  async seedTestAccount(input: { username: string; password: string; profileKey: string }): Promise<AuthUser> {
    const username = normalizeUsername(input.username);
    const existing = await this.account(username);
    if (existing) return user(existing);
    if (!/^[a-z0-9_-]{1,64}$/iu.test(input.profileKey)) throw new AppError('invalid_profile', 400);
    const passwordHash = await hashSeedPassword(input.password);
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    try {
      return await this.memory.db.transaction(async tx => {
        const profile = (await tx.query<{ id: string; demo_key: string }>('SELECT id,demo_key FROM profiles WHERE demo_key=$1 FOR UPDATE', [input.profileKey])).rows[0];
        if (!profile) throw new AppError('profile_not_found', 404);
        await tx.query('INSERT INTO user_accounts(id,username,password_hash,profile_id,created_at) VALUES($1,$2,$3,$4,$5)', [id, username, passwordHash, profile.id, createdAt]);
        return { id, username, profile_key: String(profile.demo_key) };
      });
    } catch (error) {
      if (uniqueViolation(error)) {
        const raced = await this.account(username);
        if (raced) return user(raced);
        throw new AppError('username_in_use', 409);
      }
      throw error;
    }
  }
}
