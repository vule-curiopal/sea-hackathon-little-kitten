import type { Express, Request, Response } from 'express';
import { AppError } from '../shared/types.js';
import type { AuthStore, AuthUser } from './store.js';

export const AUTH_COOKIE_NAME = 'miu_auth';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1_000;
const RATE_WINDOW = 15 * 60 * 1_000;
const MAX_RATE_KEYS = 5_000;
type AuthHttpStore = Pick<AuthStore, 'register' | 'login' | 'authenticate' | 'revoke'>;
type RateBucket = { count: number; until: number };

/** Cookie authentication is deliberately separate from voice-session bearers. */
export function requestAuthToken(request: Pick<Request, 'headers'>): string | undefined {
  const cookie = request.headers.cookie;
  if (typeof cookie !== 'string') return undefined;
  const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (matches.length !== 1) return undefined;
  try {
    const token = decodeURIComponent(matches[0]!.slice(AUTH_COOKIE_NAME.length + 1));
    return token.length > 0 && token.length <= 512 && /^[A-Za-z0-9._~-]+$/u.test(token) ? token : undefined;
  } catch { return undefined; }
}

const publicUser = (user: AuthUser): AuthUser => ({ id: user.id, username: user.username, profile_key: user.profile_key });

export async function authenticateRequest(request: Pick<Request, 'headers'>, store: Pick<AuthStore, 'authenticate'>): Promise<AuthUser | null> {
  const token = requestAuthToken(request);
  if (!token) return null;
  const user = await store.authenticate(token);
  return user ? publicUser(user) : null;
}

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && value === url.origin ? url.origin : null;
  } catch { return null; }
}

/** Reuse for authenticated writes outside /api/auth, including opening an
 * account-owned conversation. CORS headers alone do not authorize a write. */
export function assertAuthRequestOrigin(request: Request, allowedOrigins: string[]): void {
  const allowed = new Set(allowedOrigins.map(exactOrigin).filter((origin): origin is string => origin !== null));
  const suppliedOrigin = request.get('origin');
  const requestOrigin = suppliedOrigin === undefined ? undefined : exactOrigin(suppliedOrigin);
  const serverOrigin = exactOrigin(`${request.protocol}://${request.get('host') ?? ''}`);
  const configuredOrigin = requestOrigin !== undefined && requestOrigin !== null && allowed.has(requestOrigin);
  const explicitCrossOrigin = configuredOrigin && requestOrigin !== serverOrigin;
  const fetchSite = request.get('sec-fetch-site')?.toLowerCase();
  if (suppliedOrigin !== undefined && (!requestOrigin || (requestOrigin !== serverOrigin && !configuredOrigin))
    || fetchSite === 'cross-site' && !explicitCrossOrigin
    || fetchSite === 'same-site' && suppliedOrigin === undefined) throw new AppError('auth_origin_forbidden', 403);
}

function credentials(request: Request): { username: string; password: string } {
  if (!request.is('application/json')) throw new AppError('unsupported_media_type', 415);
  const body = request.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid_request', 400);
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, 'username') || !Object.hasOwn(fields, 'password')
    || typeof fields.username !== 'string' || typeof fields.password !== 'string') throw new AppError('invalid_request', 400);
  return { username: fields.username, password: fields.password };
}

/** Register before the pipeline error handler; the global JSON parser owns the
 * transport limit. Store errors keep their stable public AppError codes. */
export function registerAuthRoutes(api: Express, store: AuthHttpStore, options: { allowedOrigins: string[]; secureCookies?: boolean; onLogout?: (user: AuthUser) => Promise<void> }): void {
  const ipAttempts = new Map<string, RateBucket>();
  const usernameFailures = new Map<string, RateBucket>();

  function currentBucket(buckets: Map<string, RateBucket>, key: string, now: number): RateBucket | undefined {
    const bucket = buckets.get(key);
    if (bucket && bucket.until <= now) { buckets.delete(key); return undefined; }
    return bucket;
  }
  function addAttempt(buckets: Map<string, RateBucket>, key: string, now: number): void {
    const existing = currentBucket(buckets, key, now);
    if (existing) { existing.count++; return; }
    if (buckets.size >= MAX_RATE_KEYS) {
      for (const [oldKey, bucket] of buckets) if (bucket.until <= now) buckets.delete(oldKey);
      if (buckets.size >= MAX_RATE_KEYS) buckets.delete(buckets.keys().next().value!);
    }
    buckets.set(key, { count: 1, until: now + RATE_WINDOW });
  }
  function enforce(bucket: RateBucket | undefined, limit: number, now: number, response: Response): void {
    if (!bucket || bucket.count < limit) return;
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now) / 1_000))));
    throw new AppError('auth_rate_limited', 429);
  }
  function ipAttempt(request: Request, response: Response): void {
    const now = Date.now();
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    enforce(currentBucket(ipAttempts, key, now), 20, now, response);
    addAttempt(ipAttempts, key, now);
  }
  const usernameKey = (username: string) => username.trim().toLowerCase().slice(0, 256);
  const cookieOptions = (request: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: request.secure || options.secureCookies === true, path: '/' });

  api.use('/api/auth', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.vary('Origin');
    assertAuthRequestOrigin(request, options.allowedOrigins);
    const requestOrigin = request.get('origin');
    if (requestOrigin) {
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Max-Age', '600');
      return response.status(204).end();
    }
    return next();
  });

  api.post('/api/auth/register', async (request, response) => {
    ipAttempt(request, response);
    const { username, password } = credentials(request);
    const session = await store.register(username, password);
    response.cookie(AUTH_COOKIE_NAME, session.token, { ...cookieOptions(request), maxAge: SESSION_MAX_AGE });
    return response.status(201).json({ user: publicUser(session.user) });
  });

  api.post('/api/auth/login', async (request, response) => {
    ipAttempt(request, response);
    const { username, password } = credentials(request);
    const key = usernameKey(username);
    enforce(currentBucket(usernameFailures, key, Date.now()), 10, Date.now(), response);
    try {
      const session = await store.login(username, password);
      usernameFailures.delete(key);
      response.cookie(AUTH_COOKIE_NAME, session.token, { ...cookieOptions(request), maxAge: SESSION_MAX_AGE });
      return response.json({ user: publicUser(session.user) });
    } catch (error) {
      if (error instanceof AppError && error.code === 'invalid_credentials') addAttempt(usernameFailures, key, Date.now());
      throw error;
    }
  });

  api.get('/api/auth/me', async (request, response) => {
    const user = await authenticateRequest(request, store);
    if (!user) throw new AppError('unauthorized', 401);
    return response.json({ user });
  });

  // Logout is idempotent, including an expired or already cleared session.
  api.post('/api/auth/logout', async (request, response) => {
    const token = requestAuthToken(request);
    let user: AuthUser | null = null;
    try {
      try { user = await authenticateRequest(request, store); }
      finally { if (token) await store.revoke(token); }
    } finally { response.clearCookie(AUTH_COOKIE_NAME, cookieOptions(request)); }
    if (user && options.onLogout) {
      try { await options.onLogout(user); }
      catch { /* Account access is revoked even if conversation cleanup fails. */ }
    }
    return response.status(204).end();
  });
}
