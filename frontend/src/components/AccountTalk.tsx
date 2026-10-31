import { useEffect, useRef, useState } from 'react';
import { AUTH_CHANGED_EVENT, getCurrentUser, type AuthUser } from '../lib/auth-api';
import { useLanguage } from '../lib/i18n';
import { navigate } from '../lib/router';
import Talk from '../pages/Talk';
import Icon from './Icon';
import Miu from './Miu';

type AccountState = { status: 'loading' | 'ready' | 'error'; user: AuthUser | null };

export default function AccountTalk() {
  const { t } = useLanguage();
  const [account, setAccount] = useState<AccountState>({ status: 'loading', user: null });
  const [attempt, setAttempt] = useState(0);
  const current = useRef<AuthUser | null>(null);
  useEffect(() => {
    let active = true;
    let pending: AbortController | undefined;
    const refresh = (hidePrevious = false) => {
      pending?.abort();
      const abort = new AbortController(); pending = abort;
      if (hidePrevious || !current.current) setAccount({ status: 'loading', user: null });
      void getCurrentUser(abort.signal).then(session => {
        if (!active || abort.signal.aborted) return;
        current.current = session?.user ?? null;
        if (!session) {
          setAccount({ status: 'loading', user: null });
          navigate('/login');
        } else setAccount({ status: 'ready', user: session.user });
      }).catch(() => {
        if (!active || abort.signal.aborted) return;
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
    return () => { active = false; pending?.abort(); window.removeEventListener('focus', focus); window.removeEventListener(AUTH_CHANGED_EVENT, changed); };
  }, [attempt]);

  if (account.status === 'ready' && account.user) return <Talk user={account.user} key={account.user.id} />;
  return <main id="main-content" className="not-found">
    <Miu emotion="curious" />
    {account.status === 'loading' ? <p role="status">{t('authChecking')}</p> : <>
      <h1>{t('authSessionUnavailable')}</h1><p role="alert">{t('authNetworkError')}</p>
      <button className="button button-primary" onClick={() => setAttempt(value => value + 1)}><Icon name="refresh" />{t('authRetry')}</button>
      <a className="text-link" href="/login">{t('signIn')}<Icon name="arrow" /></a>
    </>}
  </main>;
}
