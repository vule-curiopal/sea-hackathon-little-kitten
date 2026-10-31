import { useEffect, useRef, type KeyboardEvent } from 'react';
import Icon, { type IconName } from './Icon';
import { canStartKeyboardHold, heldTalkKey, HoldToTalk, type HoldKeyboardInput, type HoldKeyboardTarget } from '../lib/hold-to-talk';

type Props = {
  className: string; label: string; text?: string; icon: IconName; disabled: boolean; recording: boolean; ready?: boolean; busy?: boolean;
  shortcutEnabled?: boolean;
  onStart(): boolean; onSend(): void; onCancel(): void;
};
export default function HoldToTalkButton(props: Props) {
  const actions = useRef(props);
  actions.current = props;
  const gesture = useRef<HoldToTalk | null>(null);
  if (!gesture.current) gesture.current = new HoldToTalk({ start: () => actions.current.onStart(), send: () => actions.current.onSend(), cancel: () => actions.current.onCancel() });
  const hold = gesture.current;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const ignoreClickUntil = useRef(-Infinity);
  const keyboardEnabled = useRef(props.shortcutEnabled !== false);
  const dialogOpen = () => !!document.querySelector('dialog[open], [aria-modal="true"]');
  function targetKind(event: globalThis.KeyboardEvent): HoldKeyboardTarget {
    const origin = event.composedPath()[0] ?? event.target ?? document.activeElement;
    const element = origin instanceof Element ? origin : document.activeElement;
    if (element && buttonRef.current?.contains(element)) return 'microphone';
    if (element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [role="listbox"], [tabindex]:not([tabindex="-1"]), button, a[href], [role="button"], [role="link"], summary, audio, video')) return 'interactive';
    return 'room';
  }
  function key(event: HoldKeyboardInput & { preventDefault(): void }, release: boolean, target: HoldKeyboardTarget) {
    const selected = heldTalkKey(event);
    if (!selected) return;
    if (target === 'microphone') ignoreClickUntil.current = performance.now() + 500;
    const owner = `key:${selected}`;
    const context = { enabled: actions.current.shortcutEnabled !== false, disabled: actions.current.disabled, dialogOpen: dialogOpen(), target };
    if (release) {
      if (hold.activeOwner !== owner) return;
      if (canStartKeyboardHold({ key: event.key, code: event.code, isComposing: event.isComposing, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }, context)) {
        event.preventDefault(); hold.release(owner);
      } else hold.cancel(owner);
      ignoreClickUntil.current = performance.now() + 500;
    } else if (canStartKeyboardHold(event, context)) {
      event.preventDefault(); ignoreClickUntil.current = performance.now() + 500;
      hold.press(owner);
    } else if (event.repeat && hold.activeOwner === owner) event.preventDefault();
  }
  useEffect(() => {
    const interrupt = () => hold.cancel();
    const hidden = () => { if (document.hidden) interrupt(); };
    const down = (event: globalThis.KeyboardEvent) => {
      const target = targetKind(event);
      if (target !== 'microphone') key(event, false, target);
    };
    const up = (event: globalThis.KeyboardEvent) => {
      const target = targetKind(event);
      if (target !== 'microphone') key(event, true, target);
    };
    window.addEventListener('blur', interrupt);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', interrupt); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      document.removeEventListener('visibilitychange', hidden); hold.cancel();
    };
  }, [hold]);
  useEffect(() => { hold.observeRecording(props.recording); }, [props.recording, hold]);
  useEffect(() => {
    const enabled = props.shortcutEnabled !== false;
    if (keyboardEnabled.current && !enabled) hold.cancel();
    keyboardEnabled.current = enabled;
  }, [props.shortcutEnabled, hold]);
  return <button ref={buttonRef} type="button" className={props.className} aria-label={props.label} aria-pressed={props.ready ?? props.recording} aria-keyshortcuts={props.shortcutEnabled === false ? undefined : 'Space Enter'} aria-busy={props.busy || undefined} disabled={props.disabled}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || actions.current.disabled || dialogOpen()) return;
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
    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => key(event, false, 'microphone')} onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => key(event, true, 'microphone')}
    onBlur={() => hold.cancel()} onContextMenu={event => event.preventDefault()} onDragStart={event => event.preventDefault()}
    onClick={event => {
      // Screen readers activate buttons without a held pointer/key: activate again to send.
      // Pointer clicks are ignored because pointerup already completed that turn.
      if (event.detail !== 0 || performance.now() < ignoreClickUntil.current || actions.current.disabled || actions.current.shortcutEnabled === false || dialogOpen()) return;
      if (hold.activeOwner === 'accessible') hold.release('accessible');
      else hold.press('accessible');
    }}>
    <Icon name={props.icon} />{props.text && <span>{props.text}</span>}
  </button>;
}
