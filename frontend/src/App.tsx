import { lazy, Suspense, useEffect } from 'react';
import { LanguageProvider, useLanguage } from './lib/i18n';
import { useRoute } from './lib/router';
import Landing from './pages/Landing';
import Auth from './pages/Auth';
import Talk from './pages/Talk';
import Miu from './components/Miu';
import { DEMO_ROUTE } from './lib/demo-buddy';

const Presentation = lazy(() => import('./pages/Presentation'));
const Growth = lazy(() => import('./pages/Growth'));

function Routes() {
  const route = useRoute();
  const { t } = useLanguage();
  useEffect(() => {
    const visibility = () => { document.documentElement.dataset.pageVisibility = document.hidden ? 'hidden' : 'visible'; };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    document.title = route === '/presentation' ? 'Meet Miu | Presentation' : `${route === '/app/growth' ? t('growthTitle') : route === '/app/talk' || route === DEMO_ROUTE ? 'Miu' : route === '/register' ? t('createTitle') : route === '/login' ? t('signInTitle') : t('meetMiu')} | Little Buddy`;
    // Announce client-side navigation without shifting initial page focus.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [route, t]);
  return <><a href="#main-content" className="skip-link">{t('skip')}</a>{route === '/presentation' ? <Suspense fallback={<main id="main-content" className="not-found"><p>Loading presentation…</p></main>}><Presentation /></Suspense> : route === '/' ? <Landing /> : route === '/register' ? <Auth /> : route === '/login' ? <Auth isLogin /> : route === '/app/growth' ? <Suspense fallback={<main id="main-content" className="container" role="status">{t('growthLoading')}</main>}><Growth /></Suspense> : route === '/app/talk' || route === DEMO_ROUTE ? <Talk guest={route === DEMO_ROUTE} /> : <main id="main-content" className="not-found"><Miu emotion="curious" /><h1>{t('notFound')}</h1><a className="button button-primary" href="/">{t('home')}</a></main>}</>;
}
export default function App() { return <LanguageProvider><Routes /></LanguageProvider>; }
