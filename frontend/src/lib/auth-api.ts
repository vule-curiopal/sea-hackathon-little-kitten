export type AuthUser = { id: string; username: string; profile_key: string };
export type AuthSession = { user: AuthUser; expires_at?: string };
export type AuthErrorCode = 'username_in_use' | 'invalid_credentials' | 'invalid_username' | 'invalid_password' | 'rate_limit' | 'auth_busy' | 'network' | 'invalid_response' | 'unavailable';
export const AUTH_CHANGED_EVENT = 'miu-auth-changed';

export class AuthApiError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number | null;
  constructor(code: AuthErrorCode, status: number | null = null) {
    super('The account request could not be completed.');
    this.name = 'AuthApiError';
    this.code = code;
    this.status = status;
  }
}

const knownErrors = new Set<AuthErrorCode>(['username_in_use', 'invalid_credentials', 'invalid_username', 'invalid_password', 'rate_limit', 'auth_busy', 'network', 'invalid_response', 'unavailable']);

function changed() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

async function request(path: string, method: 'GET' | 'POST', body?: { username: string; password: string }, signal?: AbortSignal): Promise<Response> {
  const base = (import.meta.env?.VITE_VOICE_API_URL || '').replace(/\/+$/, '');
  try {
    return await fetch(`${base}/api/auth/${path}`, {
      method, signal, credentials: 'include', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new AuthApiError('network');
  }
}

async function read(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); }
  catch {
    if (!response.ok) throw new AuthApiError(response.status === 429 ? 'rate_limit' : response.status === 503 ? 'auth_busy' : 'unavailable', response.status);
    throw new AuthApiError('invalid_response', response.status);
  }
  if (!response.ok) {
    const raw = value && typeof value === 'object' ? (value as { error?: { code?: unknown } }).error?.code : undefined;
    const code: AuthErrorCode = typeof raw === 'string' && knownErrors.has(raw as AuthErrorCode) ? raw as AuthErrorCode
      : response.status === 429 ? 'rate_limit' : response.status === 503 ? 'auth_busy' : response.status === 401 ? 'invalid_credentials' : 'unavailable';
    throw new AuthApiError(code, response.status);
  }
  return value;
}

function session(value: unknown, status: number): AuthSession {
  if (!value || typeof value !== 'object') throw new AuthApiError('invalid_response', status);
  const candidate = value as Partial<AuthSession>;
  if (!candidate.user || typeof candidate.user.id !== 'string' || !candidate.user.id
    || typeof candidate.user.username !== 'string' || !candidate.user.username
    || typeof candidate.user.profile_key !== 'string' || !candidate.user.profile_key
    || candidate.expires_at !== undefined && (typeof candidate.expires_at !== 'string' || !Number.isFinite(Date.parse(candidate.expires_at)))) {
    throw new AuthApiError('invalid_response', status);
  }
  // Only return public identity. Authentication remains in the HttpOnly cookie.
  return { user: { id: candidate.user.id, username: candidate.user.username, profile_key: candidate.user.profile_key }, ...(candidate.expires_at === undefined ? {} : { expires_at: candidate.expires_at }) };
}

async function authenticate(path: 'register' | 'login', username: string, password: string, signal?: AbortSignal): Promise<AuthSession> {
  const response = await request(path, 'POST', { username: username.trim(), password }, signal);
  const result = session(await read(response), response.status);
  changed();
  return result;
}

export function register(username: string, password: string, signal?: AbortSignal): Promise<AuthSession> {
  return authenticate('register', username, password, signal);
}

export function login(username: string, password: string, signal?: AbortSignal): Promise<AuthSession> {
  return authenticate('login', username, password, signal);
}

export async function getCurrentUser(signal?: AbortSignal): Promise<AuthSession | null> {
  const response = await request('me', 'GET', undefined, signal);
  if (response.status === 401) return null;
  return session(await read(response), response.status);
}

export async function logout(signal?: AbortSignal): Promise<void> {
  const response = await request('logout', 'POST', undefined, signal);
  if (!response.ok) await read(response);
  changed();
}
