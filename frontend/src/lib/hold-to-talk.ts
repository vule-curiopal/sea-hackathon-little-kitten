/** One held pointer/key owns one turn. Release submits once; interruption cancels. */
export class HoldToTalk {
  private owner: string | null = null;
  private readonly actions: { start(): boolean; send(): void; cancel(): void };
  constructor(actions: { start(): boolean; send(): void; cancel(): void }) { this.actions = actions; }
  get activeOwner(): string | null { return this.owner; }
  press(owner: string): boolean {
    if (this.owner !== null) return false;
    this.owner = owner;
    if (!this.actions.start()) { this.owner = null; return false; }
    return true;
  }
  release(owner: string): boolean {
    if (this.owner !== owner) return false;
    this.owner = null;
    this.actions.send(); return true;
  }
  cancel(owner?: string): void {
    if (this.owner === null || (owner !== undefined && owner !== this.owner)) return;
    this.owner = null;
    this.actions.cancel();
  }
  clear(): void { this.owner = null; }
}
