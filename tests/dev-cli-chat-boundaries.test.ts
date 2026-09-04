import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import * as browser from "../src/launcher-browser-host";
import * as driver from "../src/dev-chat/driver";
import { runDevCommand } from "../src/dev-chat/cli";
import { activateDevProfileEnvironment, resolveDevProfilePaths } from "../src/dev-chat/profile";
import { DevChatStore } from "../src/dev-chat/session";
import { RemoteTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

async function fixture(mode: "automatic" | "manual", run: (input: {
  invoke: (flags?: string[]) => Promise<void>;
  store: DevChatStore;
  descriptorPath: string;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-chat-cli-"));
  const keys = ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME", "CODEX_WEB_GPT_DEV_HOME"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network in DEV CLI test"));
  try {
    process.env.CODEX_CHATGPT_WEB_HOME = join(root, "production");
    process.env.CODEX_WEB_GPT_DEV_HOME = join(root, "development");
    const paths = resolveDevProfilePaths();
    activateDevProfileEnvironment(paths);
    const tunnel = {
      binaryPath: join(root, "absent-tunnel.exe"), tunnelId: `tunnel_${"a".repeat(32)}`,
      runtimeKeyFile: join(root, "absent-key"), profileDir: join(root, "profile"),
      profileName: "fixture", alias: "fixture",
    };
    saveConfig({
      ...defaultConfig(mode === "manual" ? "full" : "browser-only"),
      purpose: "dev-harness", browserHost: "launcher",
      ...(mode === "manual" ? { appName: "Codex Zero Risk", tunnel, manualTunnel: tunnel } : {}),
      browserInteractionMode: mode, browserHostDescriptorPath: paths.descriptorPath,
    });
    await run({
      descriptorPath: paths.descriptorPath, store: new DevChatStore(paths.chatsPath),
      invoke: async (flags = []) => {
        process.env.CODEX_CHATGPT_WEB_HOME = join(root, "production");
        await runDevCommand(["chat", "saved", ...flags, "offline fixture message"]);
      },
    });
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ["manual", "automatic"] as const) {
  test(`DEV CLI ${mode} readiness selects the matching host inspection without fallback`, async () => {
    const dom = spyOn(browser, "inspectLauncherBrowserHost").mockRejectedValue(new Error("DOM readiness sentinel"));
    const liveness = spyOn(browser, "inspectLauncherBrowserHostLiveness").mockRejectedValue(new Error("Liveness sentinel"));
    try {
      await fixture(mode, async ({ invoke, descriptorPath }) => {
        await expect(invoke()).rejects.toThrow(mode === "manual" ? "Liveness sentinel" : "DOM readiness sentinel");
        const selected = mode === "manual" ? liveness : dom;
        const unused = mode === "manual" ? dom : liveness;
        expect(selected).toHaveBeenCalledTimes(1);
        expect(selected).toHaveBeenCalledWith(descriptorPath, { expectedProfile: "development" });
        expect(unused).not.toHaveBeenCalled();
      });
    } finally { dom.mockRestore(); liveness.mockRestore(); }
  });
}

for (const explicit of [false, true]) {
  test(`DEV CLI ${explicit ? "explicit model replaces" : "omitted model preserves"} the persisted chat route`, async () => {
    const dom = spyOn(browser, "inspectLauncherBrowserHost").mockResolvedValue({
      authenticated: true, temporary: true, composer: true, url: "https://example.invalid",
    });
    const factory = spyOn(driver, "createLauncherDevAdapter").mockImplementation(config => ({
      broker: new RemoteTurnBroker(config.brokerSocketPath),
      adapterFactory: () => ({
        name: "offline-dev-cli",
        async runTurn(_parsed, _incoming, emit) {
          emit({ type: "text_delta", text: "fixture complete", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true } });
        },
      }),
    }));
    try {
      await fixture("automatic", async ({ invoke, store }) => {
        const saved = store.loadOrCreate("saved", "chatgpt-web/high", process.cwd()).state;
        store.save(saved);
        await invoke(explicit ? ["--model", "medium"] : []);
        expect(store.load("saved")).toMatchObject({
          model: explicit ? "chatgpt-web/medium" : "chatgpt-web/high", turns: 1,
        });
        expect(factory).toHaveBeenCalledTimes(1);
      });
    } finally { dom.mockRestore(); factory.mockRestore(); }
  });
}
