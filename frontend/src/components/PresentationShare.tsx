import { useEffect, useMemo, useState } from 'react';
import { isLoopbackHost } from '../lib/demo-share';
import { buildPresentationUrl } from '../lib/presentation-share';
import { createQr } from '../lib/qr';

export default function PresentationShare() {
  const [url, setUrl] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function resolve() {
      try {
        let origin = window.location.origin;
        if (isLoopbackHost(window.location.hostname)) {
          const response = await fetch('/__demo/network', { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) throw new Error('Network address unavailable');
          const network: { origin?: string | null } = await response.json();
          if (!network.origin) throw new Error('No Wi-Fi address');
          origin = network.origin;
        }
        const resolved = buildPresentationUrl(origin);
        if (!controller.signal.aborted) setUrl(resolved);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      }
    }
    void resolve();
    return () => controller.abort();
  }, []);

  const qr = useMemo(() => url ? createQr(url) : null, [url]);
  if (!qr) return <span className="pitch-screen-reader" role="status">{unavailable ? 'Open this page using your Wi-Fi address to share the slides.' : 'Preparing QR…'}</span>;

  return <aside className="pitch-share" aria-label="Open this presentation on your phone">
    <a className="pitch-share-qr" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open Meet Miu presentation">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${qr.size} ${qr.size}`} aria-hidden="true" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="var(--pop-ink)" /><path d={qr.path} fill="var(--ocean)" /></svg>
    </a>
  </aside>;
}
