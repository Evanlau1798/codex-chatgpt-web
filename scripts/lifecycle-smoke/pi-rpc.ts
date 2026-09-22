import type { Subprocess } from "bun";

type PiEvent = {
  type?: string;
  command?: string;
  success?: boolean;
  toolName?: string;
  toolCallId?: string;
  commandMatched?: boolean;
  versionObserved?: boolean;
  isError?: boolean;
  args?: { command?: string };
  result?: { content?: Array<{ type?: string; text?: string }> };
  message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> };
};
type PiRawEvent = Omit<PiEvent, "message" | "result"> & {
  message?: { role?: string; stopReason?: string; content?: unknown };
  result?: { content?: unknown };
};

export class PiRpcRun {
  readonly process: Subprocess<"pipe", "pipe", "pipe">;
  readonly events: PiEvent[] = [];
  private waiters = new Set<() => void>();
  private readTask: Promise<void>;
  private errorTask: Promise<string>;
  private readError?: Error;

  constructor(command: string[], cwd: string, env: Record<string, string>) {
    this.process = Bun.spawn({ cmd: command, cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.readTask = this.readOutput().catch(error => {
      this.readError = error instanceof Error ? error : new Error(String(error));
      this.wake();
    });
    this.errorTask = new Response(this.process.stderr).text();
  }

  private wake(): void { for (const wake of this.waiters) wake(); }

  private async readOutput(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2_000_000) throw new Error("Pi RPC output exceeded bounded frame size");
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const raw = JSON.parse(line) as PiRawEvent;
        // Keep only bounded, content-free evidence plus exact inert sentinel matches.
        const text = Array.isArray(raw.message?.content)
          ? raw.message.content.filter(part => part.type === "text").map(part => part.text ?? "").join(" ")
          : "";
        this.events.push({
          type: raw.type, command: raw.command, success: raw.success, toolName: raw.toolName, toolCallId: raw.toolCallId,
          isError: raw.isError,
          commandMatched: raw.args?.command?.trim() === "node --version",
          versionObserved: Array.isArray(raw.result?.content) && raw.result.content.some(part => part.type === "text" && /\bv\d+\.\d+\.\d+\b/.test(part.text ?? "")),
          ...(raw.message ? { message: { role: raw.message.role, stopReason: raw.message.stopReason,
            content: [{ type: "evidence", text: [
              text.includes("PI_STEER_LIVE_OK") ? "steered" : "",
              text.includes("PI_TTL_LIVE_OK") ? "resumed" : "",
              text.includes("node --version") ? "command-mentioned" : "",
            ].filter(Boolean).join(",") }] } } : {}),
        });
        if (this.events.length > 10_000) throw new Error("Pi RPC event count exceeded bound");
        this.wake();
      }
    }
  }

  async send(value: Record<string, unknown>): Promise<void> {
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
    await this.process.stdin.flush();
  }

  async waitFor(predicate: (event: PiEvent) => boolean, timeoutMs: number): Promise<PiEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.readError) throw this.readError;
      const found = this.events.find(predicate);
      if (found) return found;
      if (this.process.exitCode !== null) throw new Error("Pi RPC exited before required event");
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.min(500, deadline - Date.now()));
        this.waiters.add(wake);
      });
    }
    throw new Error("Pi RPC lifecycle event timed out");
  }

  async close(): Promise<void> {
    const naturalCode = await Promise.race([
      this.process.exited,
      Bun.sleep(100).then(() => undefined),
    ]);
    if (naturalCode === undefined) this.process.kill();
    else if (naturalCode !== 0) {
      throw new Error(`Pi RPC exited with code ${naturalCode}`);
    }
    this.process.stdin.end();
    await this.process.exited;
    await this.readTask;
    const stderr = await this.errorTask;
    if (this.readError) throw this.readError;
    if (stderr && this.events.length === 0) throw new Error(`Pi RPC failed before events: ${stderr.slice(0, 300)}`);
  }
}
