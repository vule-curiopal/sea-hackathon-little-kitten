export type AuthValues = { username: string; password: string };
export type AuthErrors = Partial<Record<keyof AuthValues, 'usernameError' | 'passwordError'>>;
export function validateAuth(values: AuthValues): AuthErrors {
  const errors: AuthErrors = {};
  if (!values.username.trim() || values.username.trim().length > 80) errors.username = 'usernameError';
  if (values.password.length < 8) errors.password = 'passwordError';
  return errors;
}
