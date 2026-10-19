/** A sampling reconnect may retain one Web owner; it never extends its execution deadline. */
export class NativeObserverHandoff {
  private epoch = 0;
  private revision = "";
  private disposed = false;
  private pending?: {
    epoch: number; revision: string; claimed: boolean;
    pause: Promise<boolean>; connect: (connected: boolean) => boolean | Promise<boolean>;
    timer: ReturnType<typeof setTimeout>; expire: () => void;
  };

  canAttach(revision: string): boolean {
    return !this.pending || this.pending.revision !== revision;
  }

  detachedRevision(): string | undefined { return this.pending?.revision; }

  attach(revision: string): number {
    if (!this.canAttach(revision)) throw new Error("Native observer reconnect requires a new current-turn instruction");
    this.disposed = false;
    if (this.pending) this.pending.claimed = true;
    this.revision = revision;
    return ++this.epoch;
  }

  detach(epoch: number, connect: (connected: boolean) => boolean | Promise<boolean>, retire: () => void, timeoutMs = 5_000): void {
    if (this.disposed || epoch !== this.epoch) return;
    if (this.pending) {
      if (this.pending.claimed) this.pending.expire();
      return;
    }
    const expire = (): void => {
      if (this.pending !== pending) return;
      this.cancel(); retire();
    };
    const timer = setTimeout(expire, timeoutMs);
    timer.unref?.();
    // Publish the lease before asynchronous owner IPC can let another request attach.
    const pending = this.pending = { epoch, revision: this.revision, claimed: false,
      pause: Promise.resolve(false), connect, timer, expire };
    try { pending.pause = Promise.resolve(connect(false)); } catch { expire(); return; }
    void pending.pause.then(paused => { if (!paused && this.pending === pending) expire(); }, () => {
      if (this.pending === pending) expire();
    });
  }

  preserves(epoch: number): boolean {
    return !this.disposed && (this.pending?.epoch === epoch || epoch < this.epoch);
  }

  async resume(): Promise<boolean> {
    const pending = this.pending;
    if (!pending?.claimed) return false;
    const epoch = this.epoch;
    const claimed = () => this.pending === pending && pending.claimed && this.epoch === epoch;
    if (!await pending.pause || !claimed()) throw new Error("Native observer handoff expired");
    if (!await pending.connect(true) || !claimed()) {
      pending.expire();
      throw new Error("Native observer handoff could not resume its owner");
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    return true;
  }

  cancel(): void {
    this.disposed = true;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
}
