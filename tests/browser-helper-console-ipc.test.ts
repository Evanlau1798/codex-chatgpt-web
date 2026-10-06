import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";

test("real child helper reserves stdout for protocol when a worker logs and debugs", async () => {
  const root = mkdtempSync(join(tmpdir(), "helper-console-ipc-"));
  const helper = join(root, "worker.ts");
  writeFileSync(helper, `
    const { ChatGptBrowserWorker } = await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)});
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      console.log('[chatgpt-web] console-log');
      console.debug('[chatgpt-web] console-debug');
      return 'PROTOCOL_OK';
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: "http://127.0.0.1:39101",
    control: { endpoint: "http://127.0.0.1:39102", token: "console-fixture-private-token-0123456789abcdef" },
    helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_console_1234567",
    surfaceTargets: { launcher_surface_console_1234567: "native-owned-target" }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const config: ResolvedBrowserConfig = { appName: "Console Fixture", browserHost: "launcher",
    browserHostDescriptorPath: descriptor, browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    headed: false, autoApproveToolCalls: false, useSavedChats: false };
  const client = new LauncherBrowserHelperClient(config);
  try {
    const answer = await client.run({ traceId: "console-protocol-123", modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "private transport fixture", images: [], release() {} }), onTextDelta() {},
    } as BrowserTurn);
    expect(answer).toBe("PROTOCOL_OK");
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
