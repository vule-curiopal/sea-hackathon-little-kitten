export type AuthValues = { username: string; password: string };
export type AuthErrors = Partial<Record<keyof AuthValues, 'usernameError' | 'passwordError' | 'passwordRequired'>>;
export function validateAuth(values: AuthValues, isLogin: boolean): AuthErrors {
  const errors: AuthErrors = {};
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/.test(values.username.trim())) errors.username = 'usernameError';
  if (isLogin) {
    if (!values.password.length) errors.password = 'passwordRequired';
  } else {
    // Count code points; never trim, normalize, or truncate passwords.
    const length = [...values.password].length;
    if (length < 12 || length > 128) errors.password = 'passwordError';
  }
  return errors;
}
