import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

// Execute the real smoke script with a controlled CLI boundary and clock. No Codex
// session, account, or live service is used, and the smoke's assertions are not copied.
const source = readFileSync(new URL("../scripts/smoke-codex-cancel.ts", import.meta.url), "utf8");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import .+;\r?\n/gm, ""));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runSmoke(options: { startupMs: number; cancellationMs?: number; replayMs?: number; noRequest?: boolean; readFailure?: boolean }) {
  const scratch = mkdtempSync(join(tmpdir(), "codex-cancel-deadline-test-"));
  let now = 0;
  let nextTimer = 0;
  let kills = 0;
  let stopped = false;
  let requests = 0;
  let output = "";
  let error = "";
  const timers = new Map<number, { at: number; callback: () => void }>();
  let handler!: (request: Request) => Promise<Response>;
  const advance = (milliseconds: number) => {
    const end = now + milliseconds;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = end;
  };
  const invoke = async () => {
    requests += 1;
    const response = await handler(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    }));
    await response.text();
  };
  const fakeBun = {
    serve(settings: { fetch: typeof handler }) {
      handler = settings.fetch;
      return { port: 12345, async stop() { stopped = true; } };
    },
    spawn() {
      const child = {
        exitCode: null as number | null,
        kill() { kills += 1; },
        stdout: options.readFailure
          ? new ReadableStream({ start(controller) { controller.error(new Error("synthetic stdout failure")); } })
          : new Response("").body,
        stderr: new Response("client_cancelled").body,
        exited: Promise.resolve(1),
      };
      child.exited = Promise.resolve().then(async () => {
        advance(options.startupMs);
        if (!kills && !options.noRequest) {
          await invoke();
          advance(options.replayMs ?? 0);
          if (!kills) await invoke();
          advance((options.cancellationMs ?? 100) - (options.replayMs ?? 0));
        }
        child.exitCode = 1;
        return 1;
      });
      return child;
    },
  };
  const inputs = {
    existsSync, mkdirSync, rmSync, writeFileSync, join, resolve,
    tmpdir: () => scratch,
    spawnSync: () => ({ status: 0, stdout: JSON.stringify({ models: [{ slug: "gpt-5.6", visibility: "list", supported_reasoning_levels: [] }] }) }),
    bridgeToResponsesSSE, defaultConfig, augmentNativeModelCatalog,
    Bun: fakeBun,
    Date: { now: () => now },
    performance: { now: () => now },
    process: { argv: [process.execPath, "smoke", process.execPath], pid: process.pid, env: {}, stdout: { write(text: string) { output += text; } } },
    setTimeout(callback: () => void, milliseconds: number) {
      const id = ++nextTimer;
      timers.set(id, { at: now + milliseconds, callback });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  };
  try {
    try { await new AsyncFunction(...Object.keys(inputs), javascript)(...Object.values(inputs)); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    return { error, output, kills, requests, stopped, timers: timers.size, leftovers: readdirSync(scratch) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("slow CLI startup does not consume the cancellation deadline", async () => {
  const result = await runSmoke({ startupMs: 20_000, cancellationMs: 100 });
  expect(result).toEqual({ error: "", output: "NATIVE_CODEX_BROWSER_TAB_CANCEL_SMOKE_OK\n", kills: 0, requests: 2, stopped: true, timers: 0, leftovers: [] });
});

test("startup is bounded separately when the CLI never sends a request", async () => {
  const result = await runSmoke({ startupMs: 30_001, noRequest: true });
  expect(result.error).toContain("startup deadline");
  expect(result.kills).toBe(1);
  expect(result.requests).toBe(0);
  expect(result.timers).toBe(0);
  expect(result.stopped).toBe(true);
  expect(result.leftovers).toEqual([]);
});

test("the first cancellation starts a fixed deadline that a replay cannot extend", async () => {
  const result = await runSmoke({ startupMs: 20_000, cancellationMs: 15_001, replayMs: 14_000 });
  expect(result.error).toContain("cancellation deadline");
  expect(result.kills).toBe(1);
  expect(result.requests).toBe(2);
  expect(result.timers).toBe(0);
});

test("an early CLI exit without a Responses request is not cancellation success", async () => {
  const result = await runSmoke({ startupMs: 100, noRequest: true });
  expect(result.error).toContain("before sending a Responses request");
  expect(result.output).toBe("");
  expect(result.kills).toBe(0);
  expect(result.timers).toBe(0);
});

test("a failed output read still disposes the deadline and owned smoke resources", async () => {
  const result = await runSmoke({ startupMs: 100, readFailure: true });
  expect(result.error).toContain("synthetic stdout failure");
  expect(result.timers).toBe(0);
  expect(result.stopped).toBe(true);
  expect(result.leftovers).toEqual([]);
});
