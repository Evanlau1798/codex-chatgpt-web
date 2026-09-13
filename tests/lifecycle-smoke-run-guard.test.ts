import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireLifecycleLock,
  captureLifecyclePostflight,
  fetchWithTimeout,
  fetchLifecycleHealth,
  lifecycleHealthIsIdle,
  lifecycleLockPath,
  releaseLifecycleLock,
} from "../scripts/lifecycle-smoke/run-guard";

test("lifecycle health must be idle before and after live lanes", () => {
  expect(lifecycleHealthIsIdle({ status: "ok", accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 })).toBeTrue();
  expect(lifecycleHealthIsIdle({ status: "ok", accepting_turns: true, active_http_turns: 1, active_browser_turns: 0 })).toBeFalse();
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "run.ts"), "utf8");
  expect(source).toContain('captureLifecyclePostflight(`${serviceBaseUrl}/healthz`)');
  expect(source).toContain("postflight_idle");
});

test("postflight preserves bounded failure evidence without retry or response content", async () => {
  const healthy = { status: "ok", accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
  const cases = [
    { fetcher: async () => Response.json({ ...healthy, secret: "PRIVATE" }), expected: { idle: true, http_status: 200, health: healthy, error: null } },
    { fetcher: async () => Response.json({ ...healthy, active_http_turns: 1 }), expected: { idle: false, health: { active_http_turns: 1 } } },
    { fetcher: async () => Response.json({ ...healthy, active_browser_turns: 1 }), expected: { idle: false, health: { active_browser_turns: 1 } } },
    { fetcher: async () => Response.json({ ...healthy, accepting_turns: false }), expected: { idle: false, health: { accepting_turns: false } } },
    { fetcher: async () => Response.json({ status: "ok", accepting_turns: true }), expected: { idle: false, health: { active_http_turns: null, active_browser_turns: null } } },
    { fetcher: async () => Response.json({ ...healthy, active_http_turns: "0" }), expected: { idle: false, health: { active_http_turns: null } } },
    { fetcher: async () => Response.json({ ...healthy, status: "PRIVATE" }), expected: { idle: false, health: { status: "not_ok" } } },
    { fetcher: async () => new Response("PRIVATE", { status: 503 }), expected: { idle: false, http_status: 503, error: "http_error" } },
    { fetcher: async () => new Response("PRIVATE", { status: 200 }), expected: { idle: false, http_status: 200, error: "invalid_health" } },
    { fetcher: async () => Response.json(null), expected: { idle: false, error: "invalid_health" } },
    { fetcher: async () => { throw new TypeError("PRIVATE"); }, expected: { idle: false, http_status: null, error: "fetch_failed" } },
  ];
  for (const { fetcher, expected } of cases) {
    let requests = 0;
    const result = await captureLifecyclePostflight("http://127.0.0.1/healthz", async () => {
      requests++;
      return fetcher();
    });
    expect(result).toMatchObject(expected);
    expect(requests).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
});

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
  expect(await captureLifecyclePostflight("http://127.0.0.1/healthz", fetcher, 10))
    .toMatchObject({ idle: false, error: "timeout", http_status: null });
});

test("every lifecycle HTTP operation can name and bound its timeout", async () => {
  const fetcher = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await expect(fetchWithTimeout("http://127.0.0.1/steer", 10, "steering", fetcher)).rejects.toThrow(
    "steering timed out",
  );
});
