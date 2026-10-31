import { isLoopbackHost } from './demo-share.ts';

export function buildPresentationUrl(origin: string) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || isLoopbackHost(base.hostname)) {
    throw new Error('Use an HTTP or HTTPS address that attendees can open on their phones.');
  }
  return new URL('/presentation', base.origin).href;
}
