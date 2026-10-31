import type { ReactNode } from 'react';

export function NightWindow() {
  return <div className="night-window" aria-hidden="true"><i className="window-moon" /><i className="star star-one" /><i className="star star-two" /><i className="window-bar horizontal" /><i className="window-bar vertical" /></div>;
}
export default function Room({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`room wall ${className}`}><NightWindow /><div className="room-floor" aria-hidden="true" /><div className="room-rug" aria-hidden="true" />{children}</div>;
}
