import { useEffect, useRef, useState, type FormEvent } from 'react';
import Miu from '../components/Miu';
import Room from '../components/Room';
import Icon from '../components/Icon';
import { useLanguage, type TranslationKey } from '../lib/i18n';
import { navigate } from '../lib/router';
import { validateAuth, type AuthErrors, type AuthValues } from '../lib/validation';
import { Brand } from './Landing';

export default function Auth({ isLogin = false }: { isLogin?: boolean }) {
  const { t, language, setLanguage } = useLanguage();
  const [values, setValues] = useState<AuthValues>({ family: '', name: '', email: '', password: '' });
  const [errors, setErrors] = useState<AuthErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { setErrors({}); setValues({ family: '', name: '', email: '', password: '' }); }, [isLogin]);
  const fields: { name: keyof AuthValues; label: TranslationKey; placeholder?: TranslationKey; type: string; autocomplete: string }[] = [
    ...(!isLogin ? [{ name: 'family' as const, label: 'family' as const, placeholder: 'familyPlaceholder' as const, type: 'text', autocomplete: 'organization' }, { name: 'name' as const, label: 'yourName' as const, placeholder: 'namePlaceholder' as const, type: 'text', autocomplete: 'given-name' }] : []),
    { name: 'email', label: 'email', placeholder: 'emailPlaceholder', type: 'email', autocomplete: 'email' },
    { name: 'password', label: 'password', type: showPassword ? 'text' : 'password', autocomplete: isLogin ? 'current-password' : 'new-password' },
  ];
  function submit(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validateAuth(values, isLogin);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    // Auth is a UI demonstration until a backend is connected. Never persist credentials.
    setValues({ family: '', name: '', email: '', password: '' });
    navigate('/app/talk');
  }
  return <main id="main-content" className="auth-page">
    <header className="auth-header container"><a className="round-button" href="/" aria-label={t('back')}><Icon name="back" /></a><Brand /><button className="language-toggle" aria-label={t('language')} onClick={() => setLanguage(language === 'en' ? 'vi' : 'en')}><Icon name="globe" />{language === 'en' ? 'VI' : 'EN'}</button></header>
    <div className="auth-layout">
      <Room className="auth-room"><div className="auth-room-copy"><span className="eyebrow-pill">{t('parentSpace')}</span><h2>{t('authBlurb')}</h2></div><div className="auth-bubble">{t('happyToMeet')}<span className="speech-tail" /></div><Miu emotion={isLogin ? 'happy' : 'excited'} /><div className="room-nameplate"><span className="small-dot" />Miu</div></Room>
      <section className="auth-card"><span className="eyebrow">Little Buddy</span><h1>{t(isLogin ? 'signInTitle' : 'createTitle')}</h1><p className="auth-subtitle">{t('authBlurb')}</p>
        <form noValidate onSubmit={submit} ref={formRef}>
          {fields.map(field => <div className="form-field" key={field.name}><label htmlFor={field.name}>{t(field.label)}</label><div className="input-wrap"><input id={field.name} name={field.name} type={field.type} autoComplete={field.autocomplete} inputMode={field.name === 'email' ? 'email' : undefined} autoCapitalize={field.name === 'email' || field.name === 'password' ? 'none' : 'words'} spellCheck={false} placeholder={field.placeholder ? t(field.placeholder) : undefined} value={values[field.name]} onChange={event => { setValues({ ...values, [field.name]: event.target.value }); if (errors[field.name]) setErrors({ ...errors, [field.name]: undefined }); }} required aria-invalid={!!errors[field.name]} aria-describedby={errors[field.name] ? `${field.name}-error` : field.name === 'password' ? 'password-hint' : undefined} />{field.name === 'password' && <button className="password-toggle" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={t(showPassword ? 'hidePassword' : 'showPassword')}><Icon name={showPassword ? 'lock' : 'check'} /></button>}</div>{errors[field.name] ? <span className="field-error" id={`${field.name}-error`} role="alert">{t(errors[field.name]!)}</span> : field.name === 'password' && <span className="field-hint" id="password-hint">{t('passwordHint')}</span>}</div>)}
          <button className="button button-primary auth-submit" type="submit">{t(isLogin ? 'continue' : 'create')}<Icon name="arrow" /></button>
          <p className="auth-demo"><Icon name="shield" />{t('authDemo')}</p>
        </form>
        <p className="auth-switch">{t(isLogin ? 'newFamily' : 'existing')} <a href={isLogin ? '/register' : '/login'}>{t(isLogin ? 'getStarted' : 'signIn')}</a></p>
        <a className="auth-demo-link text-link" href="/app/talk">{t('demoEntry')}<Icon name="arrow" /></a>
      </section>
    </div>
  </main>;
}
