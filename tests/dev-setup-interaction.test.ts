import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../src/config";
import * as tunnel from "../src/tunnel";
import * as browser from "../src/launcher-browser-host";
import { setupDevProfile } from "../src/setup";

async function fixture(run: (input: {
  setup: (mode: "automatic" | "manual", first?: boolean) => Promise<AppConfig>;
  connected: AppConfig[];
  inspected: ReturnType<typeof spyOn>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-setup-"));
  const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const connected: AppConfig[] = [];
  const mocks = [
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network in DEV setup test")),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(process.execPath),
    spyOn(tunnel, "connectTunnel").mockImplementation(config => {
      connected.push(structuredClone(config));
      mkdirSync(config.tunnel!.profileDir, { recursive: true });
      writeFileSync(join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`), config.tunnel!.tunnelId);
    }),
    spyOn(tunnel, "waitForTunnelReady").mockResolvedValue({ ok: true, processRunning: true, healthy: true, ready: true, detail: "fixture ready" }),
    spyOn(tunnel, "stopTunnel").mockImplementation(() => {}),
  ];
  const inspected = spyOn(browser, "inspectLauncherBrowserHost").mockImplementation(async (_path, options) => {
    expect(options?.expectedProfile).toBe("development");
    return { authenticated: true, temporary: true, composer: true, solAvailable: true, proAvailable: true, url: "https://example.invalid" };
  });
  try {
    await run({ connected, inspected, setup: async (mode, first = false) => {
      await setupDevProfile({
        mode: "full", browserInteractionMode: mode, acknowledgedUnofficial: true,
        browserHostDescriptorPath: join(root, "absent-browser.json"),
        ...(first ? {
          tunnelId: mode === "manual" ? "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          runtimeKeyValue: mode === "manual" ? "manual-fixture-key" : "automatic-fixture-key",
        } : {}),
      });
      return loadConfig();
    } });
  } finally {
    inspected.mockRestore();
    for (const mock of mocks.reverse()) mock.mockRestore();
    if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("first manual DEV setup keeps its isolated Zero Risk tunnel profile without browser inspection", async () => {
  await fixture(async ({ setup, connected, inspected }) => {
    const config = await setup("manual", true);
    expect(config.tunnel!.profileName).toBe("codex-chatgpt-web-dev-zero-risk");
    expect(config.tunnel!.alias).toBe("codex-chatgpt-web-dev-zero-risk");
    expect(config.tunnel).toEqual(config.manualTunnel);
    expect(connected[0]!.tunnel).toEqual(config.tunnel);
    expect(inspected).not.toHaveBeenCalled();
  });
});

test("DEV Automatic to manual to Automatic retains connector identity and both profiles", async () => {
  await fixture(async ({ setup, connected, inspected }) => {
    const original = await setup("automatic", true);
    const originalProfile = join(original.tunnel!.profileDir, `${original.tunnel!.profileName}.yaml`);
    const profileBytes = readFileSync(originalProfile);
    const keyBytes = readFileSync(original.tunnel!.runtimeKeyFile);
    const manual = await setup("manual", true);
    const restored = await setup("automatic");
    expect(restored.appName).toBe(original.appName);
    expect(restored.automaticAppName).toBe(original.automaticAppName);
    expect(restored.appName).toBe("Codex Native2 DEV");
    expect(restored.manualTunnel).toEqual(manual.manualTunnel);
    expect(readFileSync(originalProfile)).toEqual(profileBytes);
    expect(readFileSync(original.tunnel!.runtimeKeyFile)).toEqual(keyBytes);
    expect(connected.map(config => config.browserInteractionMode)).toEqual(["automatic", "manual", "automatic"]);
    expect(inspected).toHaveBeenCalledTimes(2);
  });
});
