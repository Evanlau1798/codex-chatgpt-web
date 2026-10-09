import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { _electron } from "playwright-core";

// The outer process deliberately terminates this owner without running app.close().
test("viewport owner interrupted during browser work", async () => {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/viewport.cjs"), `--user-data-dir=${process.env.VIEWPORT_OWNER_TEST_ROOT}`],
    env: { ...env, VIEWPORT_TEST_OWNER_PID: String(process.pid) },
  });
  await app.firstWindow();
  writeFileSync(process.env.VIEWPORT_OWNER_TEST_RECEIPT!, JSON.stringify({
    ownerPid: process.pid,
    electronPid: await app.evaluate(() => process.pid),
  }));
  await new Promise(() => {});
}, process.env.VIEWPORT_OWNER_TEST_TIMEOUT === "true" ? 3_000 : 30_000);
