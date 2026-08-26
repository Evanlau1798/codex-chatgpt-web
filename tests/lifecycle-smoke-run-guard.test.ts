import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireLifecycleLock,
  fetchWithTimeout,
  fetchLifecycleHealth,
  lifecycleLockPath,
  releaseLifecycleLock,
} from "../scripts/lifecycle-smoke/run-guard";

test("lifecycle lock reclaims only a demonstrably dead owner", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-lock-"));
  const path = join(root, ".active.lock");
  try {
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, nonce: "stale" }));
    const lock = acquireLifecycleLock(path);
    expect(() => acquireLifecycleLock(path)).toThrow("already active");
    releaseLifecycleLock(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle singleton path is bound to the runtime home", () => {
  expect(lifecycleLockPath("D:\\runtime-home")).toBe(join("D:\\runtime-home", "runtime", "lifecycle-smoke.lock"));
});

test("two stale-lock reclaimers cannot both acquire the lifecycle singleton", async () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-lock-race-"));
  const path = join(root, ".active.lock");
  const runner = join(root, "runner.ts");
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "run-guard.ts")).href;
  try {
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, nonce: "stale" }));
    writeFileSync(runner, [
      `import { acquireLifecycleLock, releaseLifecycleLock } from ${JSON.stringify(moduleUrl)};`,
      `const lock = acquireLifecycleLock(${JSON.stringify(path)});`,
      "await Bun.sleep(300);",
      "releaseLifecycleLock(lock);",
    ].join("\n"));
    const children = [
      Bun.spawn([process.execPath, runner], { stderr: "ignore" }),
      Bun.spawn([process.execPath, runner], { stderr: "ignore" }),
    ];
    const exits = await Promise.all(children.map(child => child.exited));
    expect(exits.toSorted()).toEqual([0, 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle health preflight aborts an unresponsive daemon", async () => {
  const fetcher = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await expect(fetchLifecycleHealth("http://127.0.0.1/healthz", 10, fetcher)).rejects.toThrow(
    "health preflight timed out",
  );
});

test("every lifecycle HTTP operation can name and bound its timeout", async () => {
  const fetcher = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await expect(fetchWithTimeout("http://127.0.0.1/steer", 10, "steering", fetcher)).rejects.toThrow(
    "steering timed out",
  );
});
