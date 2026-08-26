import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLifecycleLock,
  fetchLifecycleHealth,
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

test("lifecycle health preflight aborts an unresponsive daemon", async () => {
  const fetcher = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await expect(fetchLifecycleHealth("http://127.0.0.1/healthz", 10, fetcher)).rejects.toThrow(
    "health preflight timed out",
  );
});
