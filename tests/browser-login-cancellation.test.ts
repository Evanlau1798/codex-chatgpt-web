import { expect, test } from "bun:test";
import { execFile, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { promisify } from "node:util";
import ts from "typescript";
import { waitForBrowserExit } from "../src/browser-login-process";

const require = createRequire(import.meta.url);
const executeNative = promisify(execFile);
const source = ts.transpileModule(readFileSync(
  require.resolve("../src/browser-login-process.ts"), "utf8",
), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function loadQuit(execute: (...args: any[]) => Promise<{ stdout: string }>, timers = { setTimeout, clearTimeout }) {
  const exports: any = {};
  const command = Object.assign(() => { throw new Error("Expected promisified execution"); }, {
    [promisify.custom]: execute,
  });
  runInNewContext(source, {
    exports, module: { exports }, process, ...timers,
    require: (id: string) => id === "node:child_process" ? { execFile: command } : require(id),
  });
  return exports.quitMacApplication as (
    pid: number, executable: string, signal: AbortSignal, registrationTimeout: number,
  ) => Promise<void>;
}

test("login quit preserves ownership reason when abort interrupts the native subprocess", async () => {
  const ownership = new AbortController(), reason = new Error("Chrome exited");
  let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined, calls = 0;
  const quit = loadQuit((_file, _args, options) => {
    calls++;
    const pending = executeNative(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      signal: options.signal, timeout: options.timeout, encoding: "utf8",
    });
    child = pending.child;
    timer = setTimeout(() => ownership.abort(reason), 100);
    return pending;
  });
  const started = Date.now();
  try {
    const error = await quit(process.pid, process.execPath, ownership.signal, 10_000)
      .then(() => undefined, caught => caught as Error);
    expect(calls).toBe(1);
    expect(error?.name).toBe("AbortError");
    expect(error?.cause).toBe(reason);
    expect(Date.now() - started).toBeLessThan(3_000);
  } finally {
    clearTimeout(timer);
    ownership.abort(reason);
    if (child && !await waitForBrowserExit(child, 1_000)) {
      child.kill("SIGKILL");
      expect(await waitForBrowserExit(child, 1_000)).toBe(true);
    }
  }
});

test("login quit preserves ownership reason and clears its registration retry timer", async () => {
  const ownership = new AbortController(), reason = new Error("Chrome exited");
  let calls = 0, retryWaits = 0, cleared = 0;
  const timers = {
    setTimeout: ((callback: () => void, ms: number) => {
      expect(ms).toBe(250);
      retryWaits++;
      const timer = setTimeout(callback, ms);
      queueMicrotask(() => ownership.abort(reason));
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
      cleared++;
      clearTimeout(timer);
    }) as typeof clearTimeout,
  };
  const quit = loadQuit(async () => {
    calls++;
    return { stdout: "missing" };
  }, timers);
  const started = Date.now();
  const error = await quit(process.pid, process.execPath, ownership.signal, 10_000)
    .then(() => undefined, caught => caught as Error);
  expect(error).toBe(reason);
  expect(calls).toBe(1);
  expect(retryWaits).toBe(1);
  expect(cleared).toBe(1);
  expect(Date.now() - started).toBeLessThan(3_000);
});
