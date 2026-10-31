import { useEffect, useRef, type KeyboardEvent } from 'react';
import Icon, { type IconName } from './Icon';
import { HoldToTalk } from '../lib/hold-to-talk';

type Props = {
  className: string; label: string; text?: string; icon: IconName; disabled: boolean; recording: boolean;
  onStart(): boolean; onSend(): void; onCancel(): void;
};
export default function HoldToTalkButton(props: Props) {
  const actions = useRef(props);
  actions.current = props;
  const gesture = useRef<HoldToTalk | null>(null);
  if (!gesture.current) gesture.current = new HoldToTalk({ start: () => actions.current.onStart(), send: () => actions.current.onSend(), cancel: () => actions.current.onCancel() });
  const hold = gesture.current;
  const ignoreClickUntil = useRef(-Infinity);
  useEffect(() => {
    const interrupt = () => hold.cancel();
    window.addEventListener('blur', interrupt);
    return () => { window.removeEventListener('blur', interrupt); hold.cancel(); };
  }, [hold]);
  useEffect(() => { if (!props.recording) hold.clear(); }, [props.recording, hold]);
  function key(event: KeyboardEvent<HTMLButtonElement>, release: boolean) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    ignoreClickUntil.current = performance.now() + 500;
    if (release) hold.release(`key:${event.key}`);
    else if (!event.repeat) hold.press(`key:${event.key}`);
  }
  return <button type="button" className={props.className} aria-label={props.label} aria-pressed={props.recording} disabled={props.disabled}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      ignoreClickUntil.current = performance.now() + 500;
      event.currentTarget.focus({ preventScroll: true });
      if (hold.press(`pointer:${event.pointerId}`)) event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerUp={event => {
      ignoreClickUntil.current = performance.now() + 500;
      hold.release(`pointer:${event.pointerId}`);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={event => hold.cancel(`pointer:${event.pointerId}`)}
    onLostPointerCapture={event => hold.cancel(`pointer:${event.pointerId}`)}
    onKeyDown={event => key(event, false)} onKeyUp={event => key(event, true)}
    onBlur={() => hold.cancel()} onContextMenu={event => event.preventDefault()}
    onClick={event => {
      // Screen readers activate buttons without a held pointer/key: activate again to send.
      // Pointer clicks are ignored because pointerup already completed that turn.
      if (event.detail !== 0 || performance.now() < ignoreClickUntil.current) return;
      if (hold.activeOwner === 'accessible') hold.release('accessible');
      else hold.press('accessible');
    }}>
    <Icon name={props.icon} />{props.text && <span>{props.text}</span>}
  </button>;
}
