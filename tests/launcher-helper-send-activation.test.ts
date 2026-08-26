import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

test("browser helper waits for parent activation acknowledgement before completing Send", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-activation-"));
  const helper = join(root, "helper.cjs");
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(helper, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    let active;
    let acknowledgementTimer;
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type === "run") {
        active = message;
        send({ type: "event", id: message.id, event: "prepared_selected", reused: false });
        return;
      }
      if (message.type === "prepared_selected_ack") {
        send({ type: "event", id: message.id, event: "send_activated" });
        acknowledgementTimer = setTimeout(() => {
          send({ type: "error", id: message.id, message: "activation acknowledgement missing" });
        }, 100);
        return;
      }
      if (message.type !== "send_activated_ack" || message.id !== active?.id) return;
      clearTimeout(acknowledgementTimer);
      send({ type: "event", id: message.id, event: "submitted" });
      send({ type: "event", id: message.id, event: "text", text: "done" });
      send({ type: "result", id: message.id, text: "done" });
    });
  `, { mode: 0o700 });
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 2,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39011",
    control: {
      endpoint: "http://127.0.0.1:39012",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const client = new LauncherBrowserHelperClient(config);
  let activated = false;
  try {
    await expect(client.run({
      traceId: "activation1234",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release: () => {} }),
      onSendActivated: () => { activated = true; },
      onTextDelta: () => {},
    })).resolves.toBe("done");
    expect(activated).toBeTrue();
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
