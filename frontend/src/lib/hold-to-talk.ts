/** One held pointer/key owns one turn. Release submits once; interruption cancels. */
export class HoldToTalk {
  private owner: string | null = null;
  private observedRecording = false;
  private readonly actions: { start(): boolean; send(): void; cancel(): void };
  constructor(actions: { start(): boolean; send(): void; cancel(): void }) { this.actions = actions; }
  get activeOwner(): string | null { return this.owner; }
  press(owner: string): boolean {
    if (this.owner !== null) return false;
    this.owner = owner;
    this.observedRecording = false;
    try {
      if (!this.actions.start()) { this.clear(); return false; }
      return this.owner === owner;
    } catch (error) { this.clear(); throw error; }
  }
  release(owner: string): boolean {
    if (this.owner !== owner) return false;
    this.clear();
    this.actions.send(); return true;
  }
  cancel(owner?: string): void {
    if (this.owner === null || (owner !== undefined && owner !== this.owner)) return;
    this.clear();
    this.actions.cancel();
  }
  /** A pre-start false render may flush after press(), before React renders true. */
  observeRecording(recording: boolean): void {
    if (recording && this.owner !== null) this.observedRecording = true;
    else if (!recording && this.observedRecording) this.clear();
  }
  clear(): void { this.owner = null; this.observedRecording = false; }
}

export type HoldKeyboardTarget = 'room' | 'microphone' | 'interactive';
export type HoldKeyboardInput = {
  key: string; code?: string; repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
};
export type HoldKeyboardContext = { enabled: boolean; disabled: boolean; dialogOpen: boolean; target: HoldKeyboardTarget };

export function heldTalkKey(event: Pick<HoldKeyboardInput, 'key' | 'code'>): 'Space' | 'Enter' | null {
  if (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') return 'Space';
  return event.key === 'Enter' ? 'Enter' : null;
}

/** The room shortcut never captures text entry, another control, or a dialog. */
export function canStartKeyboardHold(event: HoldKeyboardInput, context: HoldKeyboardContext): boolean {
  const key = heldTalkKey(event);
  return context.enabled && !context.disabled && !context.dialogOpen && context.target !== 'interactive'
    && (key === 'Space' || key === 'Enter' && context.target === 'microphone')
    && !event.repeat && !event.isComposing && !event.defaultPrevented
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
