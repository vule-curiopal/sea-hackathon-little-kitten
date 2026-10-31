import { useEffect, useRef, useState, type FormEvent } from 'react';
import Miu from '../components/Miu';
import Room from '../components/Room';
import Icon from '../components/Icon';
import { useLanguage, type TranslationKey } from '../lib/i18n';
import { navigate } from '../lib/router';
import { validateAuth, type AuthErrors, type AuthValues } from '../lib/validation';
import { AuthApiError, login, register } from '../lib/auth-api';
import { Brand } from './Landing';

function errorKey(error: unknown): TranslationKey {
  switch (error instanceof AuthApiError ? error.code : 'unavailable') {
    case 'username_in_use': return 'authUsernameInUse';
    case 'invalid_credentials': return 'authInvalidCredentials';
    case 'invalid_username': return 'usernameError';
    case 'invalid_password': return 'authPasswordInvalid';
    case 'rate_limit': return 'authRateLimit';
    case 'auth_busy': return 'authBusy';
    case 'network': return 'authNetworkError';
    default: return 'authUnavailable';
  }
}

export default function Auth({ isLogin = false }: { isLogin?: boolean }) {
  const { t, language, setLanguage } = useLanguage();
  const [values, setValues] = useState<AuthValues>({ username: '', password: '' });
  const [errors, setErrors] = useState<AuthErrors>({});
  const [serverError, setServerError] = useState<TranslationKey | null>(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    requestRef.current?.abort(); requestRef.current = null;
    setErrors({}); setServerError(null); setPending(false); setShowPassword(false);
    setValues({ username: '', password: '' });
    return () => { requestRef.current?.abort(); requestRef.current = null; };
  }, [isLogin]);
  const fields: { name: keyof AuthValues; label: TranslationKey; placeholder?: TranslationKey; type: string; autocomplete: string }[] = [
    { name: 'username', label: 'username', placeholder: 'usernamePlaceholder', type: 'text', autocomplete: 'username' },
    { name: 'password', label: 'password', type: showPassword ? 'text' : 'password', autocomplete: isLogin ? 'current-password' : 'new-password' },
  ];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (requestRef.current) return;
    const nextErrors = validateAuth(values, isLogin);
    setErrors(nextErrors); setServerError(null);
    if (Object.keys(nextErrors).length) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller; setPending(true);
    try {
      await (isLogin ? login : register)(values.username, values.password, controller.signal);
      if (controller.signal.aborted) return;
      setValues({ username: '', password: '' }); setShowPassword(false);
      navigate('/app/talk');
    } catch (error) {
      if (controller.signal.aborted) return;
      setServerError(errorKey(error));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      if (requestRef.current === controller) { requestRef.current = null; setPending(false); }
    }
  }
  return <main id="main-content" className="auth-page">
    <header className="auth-header container"><a className="round-button" href="/" aria-label={t('back')}><Icon name="back" /></a><Brand /><button className="language-toggle" aria-label={t('language')} onClick={() => setLanguage(language === 'en' ? 'vi' : 'en')}><Icon name="globe" />{language === 'en' ? 'VI' : 'EN'}</button></header>
    <div className="auth-layout">
      <Room className="auth-room"><div className="auth-room-copy"><span className="eyebrow-pill">{t('parentSpace')}</span><h2>{t('authBlurb')}</h2></div><div className="auth-bubble">{t('happyToMeet')}<span className="speech-tail" /></div><Miu emotion={isLogin ? 'happy' : 'excited'} /><div className="room-nameplate"><span className="small-dot" />Miu</div></Room>
      <section className="auth-card"><span className="eyebrow">Little Buddy</span><h1>{t(isLogin ? 'signInTitle' : 'createTitle')}</h1><p className="auth-subtitle">{t(isLogin ? 'authLoginSubtitle' : 'authRegisterSubtitle')}</p>
        <form noValidate onSubmit={submit} ref={formRef} aria-busy={pending}>
          {fields.map(field => {
            const hint = field.name === 'username' ? 'usernameHint' : undefined;
            return <div className="form-field" key={field.name}>
              <label htmlFor={field.name}>{t(field.label)}</label>
              <div className="input-wrap">
                <input id={field.name} name={field.name} type={field.type} autoComplete={field.autocomplete} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  placeholder={field.placeholder ? t(field.placeholder) : undefined} value={values[field.name]} disabled={pending}
                  onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setServerError(null); if (errors[field.name]) setErrors(current => ({ ...current, [field.name]: undefined })); }}
                  required aria-invalid={!!errors[field.name]} aria-describedby={errors[field.name] ? `${field.name}-error` : hint ? `${field.name}-hint` : undefined} />
                {field.name === 'password' && <button className="password-toggle" type="button" disabled={pending} onClick={() => setShowPassword(!showPassword)} aria-label={t(showPassword ? 'hidePassword' : 'showPassword')} aria-pressed={showPassword}><Icon name={showPassword ? 'lock' : 'check'} /></button>}
              </div>
              {errors[field.name] ? <span className="field-error" id={`${field.name}-error`} role="alert">{t(errors[field.name]!)}</span> : hint && <span className="field-hint" id={`${field.name}-hint`}>{t(hint)}</span>}
            </div>;
          })}
          {serverError && <p className="field-error" id="auth-error" role="alert" tabIndex={-1} ref={errorRef}>{t(serverError)}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={pending}>{t(pending ? isLogin ? 'authSigningIn' : 'authCreating' : isLogin ? 'continue' : 'create')}<Icon name="arrow" /></button>
          <p className="auth-demo"><Icon name="shield" />{t(isLogin ? 'authDemo' : 'authRegisterDemo')}</p>
        </form>
        <p className="auth-switch">{t(isLogin ? 'newFamily' : 'existing')} <a href={isLogin ? '/register' : '/login'}>{t(isLogin ? 'getStarted' : 'signIn')}</a></p>
      </section>
    </div>
  </main>;
}
