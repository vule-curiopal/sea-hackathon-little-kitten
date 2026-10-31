import { useEffect, useRef, useState } from 'react';
import { AUTH_CHANGED_EVENT, getCurrentUser, type AuthUser } from '../lib/auth-api';
import { useLanguage } from '../lib/i18n';
import Auth from '../pages/Auth';
import { Brand } from '../pages/Landing';
import Talk from '../pages/Talk';
import Dialog from './Dialog';
import Icon from './Icon';
import Miu from './Miu';
import Room from './Room';

type AccountState = { status: 'loading' | 'ready' | 'error'; user: AuthUser | null };

export default function AccountTalk() {
  const { t, language, setLanguage } = useLanguage();
  const [account, setAccount] = useState<AccountState>({ status: 'loading', user: null });
  const [attempt, setAttempt] = useState(0);
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  const current = useRef<AuthUser | null>(null);
  const pending = useRef<AbortController | null>(null);
  const refreshVersion = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = (hidePrevious = false) => {
      pending.current?.abort();
      const abort = new AbortController(); pending.current = abort;
      const version = ++refreshVersion.current;
      if (hidePrevious || !current.current) setAccount({ status: 'loading', user: null });
      void getCurrentUser(abort.signal).then(session => {
        if (!active || abort.signal.aborted || version !== refreshVersion.current) return;
        current.current = session?.user ?? null;
        setAccount({ status: 'ready', user: session?.user ?? null });
      }).catch(() => {
        if (!active || abort.signal.aborted || version !== refreshVersion.current) return;
        current.current = null;
        setAccount({ status: 'error', user: null });
      });
    };
    const focus = () => refresh();
    const changed = () => refresh(true);
    // Keep the same verified user mounted during focus checks, so returning from
    // microphone permission does not tear down an active voice interaction.
    refresh(true);
    window.addEventListener('focus', focus);
    window.addEventListener(AUTH_CHANGED_EVENT, changed);
    return () => { active = false; pending.current?.abort(); window.removeEventListener('focus', focus); window.removeEventListener(AUTH_CHANGED_EVENT, changed); };
  }, [attempt]);

  function authenticated(user: AuthUser) {
    // The auth API has verified this identity and set the HttpOnly cookie.
    // An older /me response must not replace the newly authenticated account.
    ++refreshVersion.current; pending.current?.abort(); pending.current = null;
    current.current = user;
    setAuthMode(null); setAccount({ status: 'ready', user });
  }

  if (account.status === 'ready' && account.user) return <Talk user={account.user} key={account.user.id} />;
  return <main id="main-content" className="account-entry">
    <header className="container account-entry-header"><Brand /><button className="language-toggle" aria-label={t('language')} onClick={() => setLanguage(language === 'en' ? 'vi' : 'en')}><Icon name="globe" />{language === 'en' ? 'VI' : 'EN'}</button></header>
    <section className="container account-entry-layout">
      <Room className="account-entry-room"><Miu emotion="curious" /><div className="room-nameplate"><span className="small-dot" />Miu</div></Room>
      <div className="account-entry-copy"><span className="eyebrow">Little Buddy</span><h1>{t('authTalkTitle')}</h1><p>{t('authTalkBody')}</p>
        {account.status === 'loading' ? <p role="status" className="account-entry-status">{t('authChecking')}</p> : <>
          {account.status === 'error' && <div className="account-entry-status"><p role="alert">{t('authNetworkError')}</p><button className="text-link" onClick={() => setAttempt(value => value + 1)}><Icon name="refresh" />{t('authRetry')}</button></div>}
          <div className="account-entry-actions"><button className="button button-primary" onClick={() => setAuthMode('login')}>{t('signIn')}<Icon name="arrow" /></button><button className="button button-white" onClick={() => setAuthMode('register')}>{t('create')}</button></div>
          <p className="account-entry-note"><Icon name="lock" />{t('authTalkStay')}</p>
        </>}
      </div>
    </section>
    <Dialog open={authMode !== null} onClose={() => setAuthMode(null)} title={t(authMode === 'register' ? 'createTitle' : 'signInTitle')} className="account-auth-dialog">
      {authMode !== null && <Auth embedded isLogin={authMode === 'login'} onAuthenticated={authenticated} onModeChange={isLogin => setAuthMode(isLogin ? 'login' : 'register')} />}
    </Dialog>
  </main>;
}
