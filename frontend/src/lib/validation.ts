export type AuthValues = { username: string; password: string };
export type AuthErrors = Partial<Record<keyof AuthValues, 'usernameError' | 'passwordRequired'>>;
export function validateAuth(values: AuthValues, _isLogin: boolean): AuthErrors {
  const errors: AuthErrors = {};
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/.test(values.username.trim())) errors.username = 'usernameError';
  if (!values.password.length) errors.password = 'passwordRequired';
  return errors;
}
