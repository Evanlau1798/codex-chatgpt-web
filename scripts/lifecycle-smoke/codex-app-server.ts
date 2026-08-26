import { appendFileSync } from "node:fs";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../../src/stall-timeout";
import { assert, codexExe, events, iso, repo, serviceBaseUrl, sleep } from "./common";
import { CodexLifecycleProgressSignals } from "./progress-signals";
import { LifecycleProgressWatchdog } from "./progress-watchdog";

export const activeTurnSmokeTimeoutMs = 45 * 60_000;
export const lifecycleSemanticInactivityMs = DEFAULT_STALL_TIMEOUT_SEC * 3 * 1_000 + 60_000;
export const lifecycleNativeToolLeaseMs = 150_000;
export const lifecycleNativeToolMaxMs = 15 * 60_000;

export type Rpc = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
  receivedAt?: string;
};

export type AgentTextStreamDiagnostic = {
  deltaCount: number;
  replays: Array<{
    kind: "same_item_prefix" | "cross_item_prefix";
    threadId: string;
    turnId: string;
    itemId: string;
    priorItemId?: string;
    repeatedChars: number;
  }>;
  reconstructionMismatches: Array<{
    threadId: string;
    turnId: string;
    itemId: string;
    deltaChars: number;
    completedChars: number;
  }>;
};

export function agentTextStreamDiagnostic(
  messages: Rpc[],
  since = 0,
  minimumReplayChars = 24,
): AgentTextStreamDiagnostic {
  const streams = new Map<string, string>();
  const itemIdentity = new Map<string, { threadId: string; turnId: string; itemId: string }>();
  const lastItemByTurn = new Map<string, string>();
  const replays: AgentTextStreamDiagnostic["replays"] = [];
  let deltaCount = 0;
  for (const message of messages) {
    if (message.method !== "item/agentMessage/delta" || Date.parse(message.receivedAt ?? "") < since) continue;
    const threadId = String(message.params?.threadId ?? "");
    const turnId = String(message.params?.turnId ?? "");
    const itemId = String(message.params?.itemId ?? "");
    const delta = String(message.params?.delta ?? "");
    if (!threadId || !turnId || !itemId || !delta) continue;
    deltaCount += 1;
    const key = `${threadId}\u0000${turnId}\u0000${itemId}`;
    const turnKey = `${threadId}\u0000${turnId}`;
    const current = streams.get(key) ?? "";
    if (current.length >= minimumReplayChars && delta.startsWith(current)) {
      replays.push({ kind: "same_item_prefix", threadId, turnId, itemId, repeatedChars: current.length });
    } else if (!current) {
      const priorKey = lastItemByTurn.get(turnKey);
      const prior = priorKey ? streams.get(priorKey) ?? "" : "";
      if (priorKey && prior.length >= minimumReplayChars && delta.startsWith(prior)) {
        replays.push({
          kind: "cross_item_prefix",
          threadId,
          turnId,
          itemId,
          priorItemId: itemIdentity.get(priorKey)?.itemId,
          repeatedChars: prior.length,
        });
      }
    }
    streams.set(key, current + delta);
    itemIdentity.set(key, { threadId, turnId, itemId });
    lastItemByTurn.set(turnKey, key);
  }
  const reconstructionMismatches: AgentTextStreamDiagnostic["reconstructionMismatches"] = [];
  for (const message of messages) {
    if (message.method !== "item/completed" || Date.parse(message.receivedAt ?? "") < since
      || message.params?.item?.type !== "agentMessage") continue;
    const threadId = String(message.params?.threadId ?? "");
    const turnId = String(message.params?.turnId ?? "");
    const itemId = String(message.params?.item?.id ?? "");
    const key = `${threadId}\u0000${turnId}\u0000${itemId}`;
    const reconstructed = streams.get(key);
    if (reconstructed === undefined) continue;
    const completed = String(message.params.item.text ?? "");
    if (reconstructed !== completed) {
      reconstructionMismatches.push({
        threadId,
        turnId,
        itemId,
        deltaChars: reconstructed.length,
        completedChars: completed.length,
      });
    }
  }
  return { deltaCount, replays, reconstructionMismatches };
}

export function selfTestAgentTextStreamDiagnostic(): void {
  const at = new Date().toISOString();
  const delta = (itemId: string, text: string): Rpc => ({
    method: "item/agentMessage/delta",
    params: { threadId: "thread", turnId: "turn", itemId, delta: text },
    receivedAt: at,
  });
  const phrase = "a stable commentary prefix that must not replay";
  const clean = agentTextStreamDiagnostic([delta("one", phrase), delta("one", " and its suffix")]);
  assert(clean.replays.length === 0, "clean agent text stream was classified as replay");
  const same = agentTextStreamDiagnostic([delta("one", phrase), delta("one", `${phrase} again`)]);
  assert(same.replays.some(value => value.kind === "same_item_prefix"), "same-item replay self-test failed");
  const cross = agentTextStreamDiagnostic([delta("one", phrase), delta("two", `${phrase} again`)]);
  assert(cross.replays.some(value => value.kind === "cross_item_prefix"), "cross-item replay self-test failed");
}

export function selfTestActiveTurnSmokeBudget(): void {
  assert(
    activeTurnSmokeTimeoutMs > 30 * 60_000,
    "Lifecycle smoke active-turn ceiling must exceed the supported 30-minute active-turn window",
  );
  assert(
    lifecycleNativeToolLeaseMs > 120_000,
    "Lifecycle native-tool lease must include margin beyond the production pulse interval",
  );
  assert(
    lifecycleNativeToolMaxMs < activeTurnSmokeTimeoutMs,
    "Lifecycle native-tool proof must remain bounded below the absolute turn ceiling",
  );
}

type Waiter = { predicate: (message: Rpc) => boolean; resolve: (message: Rpc) => void };

export class CodexRun {
  readonly received: Rpc[] = [];
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private waiters = new Set<Waiter>();
  private stdoutTask: Promise<void>;
  private stderrTask: Promise<void>;
  private outputQueue: string[] = [];
  private stderrQueue: string[] = [];

  constructor(private output: string, compactLimit = true) {
    const provider = [
      "-c", 'model_provider="lifecycle_smoke"',
      "-c", 'model_providers.lifecycle_smoke.name="Lifecycle Smoke"',
      "-c", `model_providers.lifecycle_smoke.base_url="${serviceBaseUrl}/v1"`,
      "-c", 'model_providers.lifecycle_smoke.wire_api="responses"',
      "-c", "model_providers.lifecycle_smoke.request_max_retries=0",
      "-c", "model_providers.lifecycle_smoke.stream_max_retries=0",
      "-c", "model_providers.lifecycle_smoke.supports_websockets=false",
    ];
    const compact = compactLimit
      ? ["-c", "model_auto_compact_token_limit=100000", "-c", 'model_auto_compact_token_limit_scope="body_after_prefix"']
      : [];
    this.process = Bun.spawn({
      cmd: [codexExe, ...provider, ...compact, "app-server", "--listen", "stdio://"],
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdoutTask = this.read(this.process.stdout, line => this.handle(JSON.parse(line)));
    this.stderrTask = this.read(this.process.stderr, line => {
      this.appendDiagnostic(this.stderrQueue, output.replace(/\.jsonl$/, ".stderr.log"), `${line}\n`);
    });
  }

  private appendDiagnostic(queue: string[], path: string, value: string) {
    queue.push(value);
    this.flushDiagnostic(queue, path);
  }

  private flushDiagnostic(queue: string[], path: string) {
    if (queue.length === 0) return;
    const value = queue.join("");
    try {
      appendFileSync(path, value);
      queue.splice(0, queue.length);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    }
  }

  private async read(stream: ReadableStream<Uint8Array>, handle: (line: string) => void) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line) handle(line);
      }
    }
  }

  private handle(message: Rpc) {
    message.receivedAt = iso();
    this.received.push(message);
    this.appendDiagnostic(this.outputQueue, this.output, `${JSON.stringify(message)}\n`);
    if (message.id !== undefined && message.method === "mcpServer/elicitation/request") {
      void this.send({ id: message.id, result: { action: "accept", content: {}, _meta: { persist: "session" } } });
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  private async send(message: Rpc) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    await this.process.stdin.flush();
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "full-lifecycle-smoke", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await this.send({ method: "initialized" });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 30_000) {
    const id = this.nextId++;
    let timer: Timer;
    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    });
    await this.send({ id, method, params });
    try {
      return await response;
    } finally {
      clearTimeout(timer!);
      this.pending.delete(id);
    }
  }

  async waitFor(predicate: (message: Rpc) => boolean, timeoutMs: number, label: string) {
    const existing = this.received.findLast(predicate);
    if (existing) return existing;
    let timer: Timer;
    let entry: Waiter;
    const result = new Promise<Rpc>((resolve, reject) => {
      entry = { predicate, resolve };
      this.waiters.add(entry);
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    try {
      return await result;
    } finally {
      clearTimeout(timer!);
      this.waiters.delete(entry!);
    }
  }

  messages(threadId: string) {
    return this.received.flatMap(message => message.method === "item/completed"
      && message.params?.threadId === threadId && message.params?.item?.type === "agentMessage"
      ? [String(message.params.item.text)] : []);
  }

  compactions(threadId: string) {
    return new Set(this.received.flatMap(message => message.method === "item/completed"
      && message.params?.threadId === threadId && message.params?.item?.type === "contextCompaction"
      ? [message.params.item.id] : [])).size;
  }

  firstClientTimes(after: number) {
    const value = this.received.filter(message => Date.parse(message.receivedAt ?? "") >= after);
    return {
      client_first_reasoning: value.find(message => /reasoning/i.test(message.method ?? "") && /delta/i.test(message.method ?? ""))?.receivedAt ?? null,
      client_first_text: value.find(message => message.method === "item/agentMessage/delta")?.receivedAt ?? null,
    };
  }

  async close() {
    this.process.stdin.end();
    const code = await Promise.race([this.process.exited, sleep(15_000).then(() => null)]);
    if (code === null) {
      this.process.kill();
      await this.process.exited;
    }
    await Promise.all([this.stdoutTask, this.stderrTask]);
    for (let attempt = 0; attempt < 20 && (this.outputQueue.length || this.stderrQueue.length); attempt += 1) {
      this.flushDiagnostic(this.outputQueue, this.output);
      this.flushDiagnostic(this.stderrQueue, this.output.replace(/\.jsonl$/, ".stderr.log"));
      if (this.outputQueue.length || this.stderrQueue.length) await sleep(50);
    }
    assert(this.outputQueue.length === 0, "Codex app-server diagnostic output remained locked");
    assert(this.stderrQueue.length === 0, "Codex app-server stderr diagnostic output remained locked");
  }
}

export async function completed(run: CodexRun, turnId: string, timeoutMs: number) {
  const started = run.received.findLast(value => (
    value.method === "turn/started" && value.params?.turn?.id === turnId
  ));
  const startedAt = Date.parse(started?.receivedAt ?? "") || Date.now();
  const watcher = new LifecycleProgressWatchdog({
    startedAt,
    inactivityMs: lifecycleSemanticInactivityMs,
    absoluteMs: timeoutMs,
    nativeToolLeaseMs: lifecycleNativeToolLeaseMs,
    nativeToolMaxMs: lifecycleNativeToolMaxMs,
  });
  const signals = new CodexLifecycleProgressSignals();
  let receivedIndex = 0;
  let launcherIndex = 0;
  for (;;) {
    const message = run.received.findLast(value => (
      value.method === "turn/completed" && value.params?.turn?.id === turnId
    ));
    if (message) {
      assert(message.params?.turn?.status === "completed", `turn failed: ${message.params?.turn?.error?.message ?? "unknown"}`);
      return;
    }
    for (const value of run.received.slice(receivedIndex)) {
      const valueTurnId = String(value.params?.turnId ?? value.params?.turn?.id ?? "");
      if (valueTurnId === turnId) {
        watcher.observe(signals.fromRpc(value), Date.parse(value.receivedAt ?? "") || Date.now());
      }
    }
    receivedIndex = run.received.length;
    const launcher = events(startedAt);
    for (const value of launcher.slice(launcherIndex)) {
      watcher.observe(signals.fromLauncher(value), Date.parse(value.at));
    }
    launcherIndex = launcher.length;
    const status = watcher.status(Date.now());
    if (status.timedOut) {
      throw new Error(`turn ${turnId} timed out: ${status.reason}`);
    }
    await sleep(500);
  }
}
