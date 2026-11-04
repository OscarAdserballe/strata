/* A failure only raises a doubt; the room is called down after nothing has answered for `grace` ms. */
export interface WireOptions {
  probe(): Promise<boolean>;
  changed(down: boolean): void;
  down?: boolean;
  grace?: number;
  hidden?(): boolean;
  now?(): number;
}

export class Wire {
  down: boolean;
  private o: WireOptions;
  private grace: number;
  private now: () => number;
  private doubtSince: number | null = null;   // when the current run of failures began
  private misses = 0;           // probes failed since going down — the backoff's exponent
  private timer: ReturnType<typeof setTimeout> | null = null;
  private probing = false;

  constructor(o: WireOptions) {
    this.o = o;
    this.down = !!o.down;
    this.grace = o.grace ?? 8000;
    this.now = o.now ?? Date.now;
  }

  /** Something that should have reached the server did not. */
  failed(): void {
    if (!this.down && this.doubtSince === null) this.doubtSince = this.now();
    if (!this.timer && !this.probing) this.ask(0);
  }

  /** A response came back off the wire. */
  answered(): void {
    this.doubtSince = null; this.misses = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.down) { this.down = false; this.o.changed(false); }
  }

  private ask(delay: number): void {
    this.timer = setTimeout(() => { this.timer = null; void this.check(); }, delay);
  }

  private async check(): Promise<void> {
    if (this.probing || (!this.down && this.doubtSince === null)) return;
    this.probing = true;
    let ok = false;
    try { ok = await this.o.probe(); } catch { ok = false; }
    this.probing = false;
    if (ok) { this.answered(); return; }
    if (!this.down && this.doubtSince === null) return;  // something else answered meanwhile
    if (!this.down && this.now() - this.doubtSince! >= this.grace) {
      this.down = true; this.doubtSince = null; this.misses = 0;
      this.o.changed(true);
    }
    if (this.timer) return;
    if (!this.down) { this.ask(1000); return; }
    // down: the next failed() or the page coming back into view starts the asking again
    if (this.o.hidden?.()) return;
    this.ask(Math.min(30000, 2000 * 2 ** this.misses++));
  }
}
