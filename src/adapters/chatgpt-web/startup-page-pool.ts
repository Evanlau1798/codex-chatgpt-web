export type StartupPageResource = {
  surfaceId: string;
  prefix: string;
  pauseHeartbeat(): void;
  release(): Promise<void>;
  isAvailable?(): boolean;
};

type StartupPagePreparation<T> = (signal: AbortSignal, registerCleanup: (release: () => Promise<void>) => void) => Promise<T>;

/** One speculative owner; a claim transfers its existing slot rather than reserving another. */
export class ChatGptStartupPagePool<T extends StartupPageResource> {
  private revision = 0;
  private current?: { key: string; prefix: string; controller: AbortController; resource?: T;
    work: Promise<void>; cleanup?: () => Promise<void>; released?: Promise<void> };
  private claimed = new Map<T, NonNullable<typeof this.current>>();
  private retired = new Set<NonNullable<typeof this.current>>();
  private retiring: Promise<void> = Promise.resolve();
  private upkeep?: { cancelled: boolean; timer?: ReturnType<typeof setTimeout> };

  /** Capacity may be released by TTL without another request. Never retry login/rate/other failures. */
  async maintain(key: string, prefix: string, prepare: StartupPagePreparation<T>, delayMs = 10_000): Promise<void> {
    this.stopUpkeep();
    const owner = { cancelled: false } as NonNullable<typeof this.upkeep>;
    this.upkeep = owner;
    const run = async () => {
      if (owner.cancelled) return;
      try { await this.prime(key, prefix, prepare); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("no available account-safety capacity")) {
          if (this.upkeep === owner) this.stopUpkeep();
          return;
        }
      }
      if (!owner.cancelled) {
        owner.timer = setTimeout(() => { void run(); }, delayMs);
        owner.timer.unref?.();
      }
    };
    await run();
  }

  private stopUpkeep(): void {
    if (!this.upkeep) return;
    this.upkeep.cancelled = true;
    if (this.upkeep.timer) clearTimeout(this.upkeep.timer);
    this.upkeep = undefined;
  }

  async prime(key: string, prefix: string, prepare: StartupPagePreparation<T>): Promise<void> {
    if (this.current?.key === key && this.current.prefix === prefix
      && this.current.resource?.isAvailable?.() !== false) return this.current.work;
    const ticket = ++this.revision;
    this.retireCurrent();
    await this.drainRetired();
    if (ticket !== this.revision) return;
    const entry = { key, prefix, controller: new AbortController(), work: Promise.resolve() } as NonNullable<typeof this.current>;
    this.current = entry;
    entry.work = (async () => {
      try {
        entry.resource = await prepare(entry.controller.signal, cleanup => { entry.cleanup = cleanup; });
        if (this.current !== entry || entry.controller.signal.aborted) await this.release(entry);
      } catch (error) {
        if (this.current === entry) this.current = undefined;
        if (entry.cleanup || entry.resource) this.retired.add(entry);
        if (!entry.controller.signal.aborted) throw error;
      }
    })();
    return entry.work;
  }

  take(key: string): T | undefined {
    const entry = this.current;
    if (!entry?.resource || entry.key !== key || entry.controller.signal.aborted
      || entry.resource.isAvailable?.() === false) return undefined;
    this.stopUpkeep();
    this.current = undefined;
    this.revision++;
    entry.resource.pauseHeartbeat();
    this.claimed.set(entry.resource, entry);
    return entry.resource;
  }

  /** A claim is not retired until its exact launcher owner acknowledges cleanup. */
  async releaseClaim(resource: T): Promise<void> {
    const entry = this.claimed.get(resource);
    if (entry) {
      this.claimed.delete(resource);
      this.retired.add(entry);
    }
    await this.drainRetired();
  }

  async cancel(): Promise<void> {
    this.stopUpkeep();
    this.revision++;
    this.retireCurrent();
    await this.drainRetired();
  }

  private retireCurrent(): void {
    const entry = this.current;
    this.current = undefined;
    if (!entry) return;
    this.retired.add(entry);
    entry.controller.abort();
  }

  private drainRetired(): Promise<void> {
    if (!this.retired.size) return this.retiring;
    // Retry unresolved owners on the next request; never allocate past missing acknowledgement.
    return this.retiring = this.retiring.catch(() => {}).then(async () => {
      for (const entry of this.retired) {
        await entry.work.catch(() => {});
        await this.release(entry);
        this.retired.delete(entry);
      }
    });
  }

  private release(entry: NonNullable<typeof this.current>): Promise<void> {
    const cleanup = entry.cleanup ?? (entry.resource ? () => entry.resource!.release() : undefined);
    return entry.released ??= Promise.resolve().then(() => cleanup?.()).catch(error => {
      entry.released = undefined;
      throw error;
    });
  }
}
