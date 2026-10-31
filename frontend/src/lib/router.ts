import { useEffect, useState } from 'react';

export function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function useRoute() {
  const [route, setRoute] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setRoute(window.location.pathname);
    const follow = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest('a');
      if (!link || link.target || link.hasAttribute('download')) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.hash) return;
      event.preventDefault();
      navigate(url.pathname + url.search);
    };
    window.addEventListener('popstate', update);
    document.addEventListener('click', follow);
    return () => { window.removeEventListener('popstate', update); document.removeEventListener('click', follow); };
  }, []);
  return route;
}
