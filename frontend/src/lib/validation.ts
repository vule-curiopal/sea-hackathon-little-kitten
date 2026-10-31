export type AuthValues = { family: string; name: string; email: string; password: string };
export type AuthErrors = Partial<Record<keyof AuthValues, 'familyError' | 'nameError' | 'emailError' | 'passwordError'>>;
export function validateAuth(values: AuthValues, isLogin: boolean): AuthErrors {
  const errors: AuthErrors = {};
  if (!isLogin && !values.family.trim()) errors.family = 'familyError';
  if (!isLogin && !values.name.trim()) errors.name = 'nameError';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) errors.email = 'emailError';
  if (values.password.length < 8) errors.password = 'passwordError';
  return errors;
}
