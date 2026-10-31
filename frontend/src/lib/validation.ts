export type AuthValues = { email: string; password: string };
export type AuthErrors = Partial<Record<keyof AuthValues, 'emailError' | 'passwordError'>>;
export function validateAuth(values: AuthValues): AuthErrors {
  const errors: AuthErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) errors.email = 'emailError';
  if (values.password.length < 8) errors.password = 'passwordError';
  return errors;
}
