import type { BrowserTurn } from "./browser-worker";
import { ChatGptMirroredTurnProgress, type ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

type Waiter<T> = { requestId: number; resolve: (value: T) => void; reject: (error: Error) => void };
type Session = {
  progress: ChatGptMirroredTurnProgress;
  begin?: Waiter<number | undefined>;
  commit?: Waiter<boolean>;
};

export class BrowserHelperFenceRegistry {
  private readonly sessions = new Map<string, Session>();
  private nextRequestId = 0;

  constructor(
    private readonly write: (message: unknown) => boolean,
    private readonly diagnostic: (message: string) => void,
  ) {}

  start(id: string, enabled: boolean): Pick<BrowserTurn, "externalProgress" | "completionFence"> {
    if (!enabled) return {};
    const session: Session = {
      progress: new ChatGptMirroredTurnProgress(revision => {
        if (!this.write({ type: "event", id, event: "tool_batch_observed", revision })) {
          throw new Error("Browser helper could not acknowledge the observed Codex tool boundary");
        }
      }),
    };
    this.sessions.set(id, session);
    return {
      externalProgress: session.progress,
      completionFence: {
        begin: () => this.request(id, "begin"),
        commit: revision => this.request(id, "commit", revision),
      },
    };
  }

  apply(id: string, snapshot: ChatGptExternalTurnProgressSnapshot): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.progress.apply(snapshot);
    } catch (error) {
      this.diagnostic(`[chatgpt-web] discarded an invalid MCP progress frame for ${id}: ${errorOf(error).message}`);
    }
  }

  resolveBegin(id: string, requestId: number, revision: number | null): void {
    if (!Number.isSafeInteger(requestId) || requestId <= 0
      || (revision !== null && (!Number.isSafeInteger(revision) || revision < 0))) {
      throw new Error("Browser helper completion fence revision is invalid");
    }
    const session = this.sessions.get(id);
    const waiter = session?.begin;
    if (!waiter || waiter.requestId !== requestId) return;
    session!.begin = undefined;
    waiter.resolve(revision ?? undefined);
  }

  resolveCommit(id: string, requestId: number, committed: boolean): void {
    if (!Number.isSafeInteger(requestId) || requestId <= 0 || typeof committed !== "boolean") {
      throw new Error("Browser helper completion fence result is invalid");
    }
    const session = this.sessions.get(id);
    const waiter = session?.commit;
    if (!waiter || waiter.requestId !== requestId) return;
    session!.commit = undefined;
    waiter.resolve(committed);
  }

  end(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const error = new DOMException("Browser helper completion fence aborted", "AbortError");
    session.begin?.reject(error);
    session.commit?.reject(error);
    this.sessions.delete(id);
  }

  close(): void {
    for (const id of this.sessions.keys()) this.end(id);
  }

  private request(id: string, kind: "begin"): Promise<number | undefined>;
  private request(id: string, kind: "commit", revision: number): Promise<boolean>;
  private request(id: string, kind: "begin" | "commit", revision?: number): Promise<number | boolean | undefined> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error("Browser helper completion fence is unavailable"));
    if (session[kind]) return Promise.reject(new Error(`Browser helper completion fence already awaits ${kind}`));
    return new Promise((resolve, reject) => {
      const requestId = ++this.nextRequestId;
      session[kind] = { requestId, resolve, reject } as never;
      const event = kind === "begin" ? "completion_fence_begin" : "completion_fence_commit";
      if (this.write({ type: "event", id, event, requestId, ...(revision !== undefined ? { revision } : {}) })) return;
      session[kind] = undefined;
      reject(new Error(`Browser helper could not ${kind} the broker completion fence`));
    });
  }
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
