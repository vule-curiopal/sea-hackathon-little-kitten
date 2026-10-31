import type { SVGProps } from 'react';

const paths = {
  qr: <><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM21 12v3M12 3v3M12 10v3H9M3 12h3M12 18v3" /></>,
  arrow: <path d="m10 5 7 7-7 7M17 12H4" />,
  back: <path d="m14 5-7 7 7 7" />,
  mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" /></>,
  muted: <><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.8-1M5 10a7 7 0 0 0 12 5M19 10a7 7 0 0 1-.5 2.6M12 17v5m-4 0h8M3 3l18 18" /></>,
  chat: <><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-6 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M8 9h8m-8 4h5" /></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 15h8" /></>,
  refresh: <><path d="M20 10a8 8 0 1 0-1.6 7M20 3v7h-7" /></>,
  settings: <><path d="M3 7h10m6 0h2M3 17h4m6 0h8" /><circle cx="16" cy="7" r="3" /><circle cx="10" cy="17" r="3" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  play: <path d="m9 5 10 7-10 7V5Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  sound: <><path d="m11 4-6 5H2v6h3l6 5V4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
  silent: <><path d="m11 4-6 5H2v6h3l6 5V4Zm5 5 6 6m0-6-6 6" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" /></>,
  sparkle: <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z" />,
};
export type IconName = keyof typeof paths;
export default function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
