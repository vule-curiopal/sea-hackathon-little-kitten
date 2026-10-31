import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '../lib/i18n';
import { buildDemoUrl, isLoopbackHost } from '../lib/demo-share';
import { createQr } from '../lib/qr';
import Icon from './Icon';

export default function DemoShare() {
  const { t, language } = useLanguage();
  const [origin, setOrigin] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const configured = import.meta.env.VITE_DEMO_PUBLIC_URL;
    async function resolve() {
      try {
        if (configured) { buildDemoUrl(configured, 'en'); setOrigin(new URL(configured).origin); return; }
        if (!isLoopbackHost(window.location.hostname)) { setOrigin(window.location.origin); return; }
        const response = await fetch('/__demo/network', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Network address unavailable');
        const result: { origin?: string | null } = await response.json();
        if (!result.origin) throw new Error('No Wi-Fi address');
        buildDemoUrl(result.origin, 'en');
        if (!controller.signal.aborted) setOrigin(result.origin);
      } catch { if (!controller.signal.aborted) setLinkError(true); }
    }
    void resolve();
    return () => controller.abort();
  }, []);

  const url = useMemo(() => origin ? buildDemoUrl(origin, language) : null, [origin, language]);
  const qr = useMemo(() => url ? createQr(url) : null, [url]);
  if (!url || !qr) return <span className="room-demo-qr qr-loading" role="status" aria-label={t(linkError ? 'qrUnavailable' : 'qrLoading')} title={t(linkError ? 'qrUnavailable' : 'qrLoading')}><Icon name="qr" /></span>;
  return <a className="room-demo-qr" href={url} target="_blank" rel="noopener noreferrer" aria-label={t('qrLabel')} title={t('scanToMeet')}><svg className="demo-qr" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${qr.size} ${qr.size}`} aria-hidden="true" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="var(--pop-ink)" /><path d={qr.path} fill="var(--ocean)" /></svg></a>;
}
