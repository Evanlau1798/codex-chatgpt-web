import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../src/config";
import * as integration from "../src/codex-integration";
import * as service from "../src/service";
import * as tunnel from "../src/tunnel";
import * as tunnelService from "../src/tunnel-service";
import * as browserHost from "../src/launcher-browser-host";
import * as browserLogin from "../src/browser-login";
import { launcherCapabilityProbeRequired, setupIntegrationSelection, setup, setupDevProfile, setupProxyIsReady } from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup reuses fresh per-model observations unless a refresh is requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
    modelCapabilities: { observedAt: Date.now(), families: { "5.6": ["low", "medium", "high"] } },
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({ ...verifiedLauncher, extraHighAvailable: undefined } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    extraHighAvailable: false, proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never, true)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never, false, "automatic")).toBe(true);
});

test("setup defaults to Codex and requires an explicit Claude or combined target", () => {
  expect(setupIntegrationSelection()).toEqual({ codex: true, claude: false });
  expect(setupIntegrationSelection("codex")).toEqual({ codex: true, claude: false });
  expect(setupIntegrationSelection("claude")).toEqual({ codex: false, claude: true });
  expect(setupIntegrationSelection("all")).toEqual({ codex: true, claude: true });
});

for (const development of [false, true]) for (const interaction of ["manual", "automatic"] as const) {
  test(`${development ? "DEV" : "production"} ${interaction} setup commits the tunnel inputs before its supervisor starts the runtime`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-setup-owner-"));
    const key = join(root, "runtime.key");
    writeFileSync(key, "fixture-runtime-key");
    const calls: string[] = [];
    let saved: configModule.AppConfig | undefined;
    const mocks = [
      spyOn(configModule, "getConfigPath").mockReturnValue(join(root, "config.json")),
      spyOn(configModule, "saveConfig").mockImplementation(value => { saved = value; calls.push("save"); }),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => { calls.push("integrate"); return {} as never; }),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
      spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
      spyOn(tunnel, "connectTunnel").mockImplementation(() => { throw new Error("setup started a runtime before committing its inputs"); }),
      spyOn(tunnel, "stopTunnel").mockImplementation(() => { throw new Error("setup stopped the supervisor's runtime"); }),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockResolvedValue({ solAvailable: true, proAvailable: true, extraHighAvailable: true } as never),
    ];
    try {
      const options = {
        mode: "full" as const,
        useEnhancedWebSessionMode: false,
        browserInteractionMode: interaction,
        subagentProtocol: "native" as const,
        browserHostDescriptorPath: join(root, "launcher-browser.json"),
        tunnelId: `tunnel_${"a".repeat(32)}`,
        acknowledgedUnofficial: true,
      };
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const result = await (development ? setupDevProfile : setup)({ ...options, port,
        ...(interaction === "automatic" ? { experimentalFreshConversationPerTurn: true } : {}),
        useSavedChats: true,
      });
      expect(calls).toEqual(development ? ["save"] : ["save", "integrate"]);
      expect(saved?.tunnel?.alias).toBe(`codex-chatgpt-web${development ? "-dev" : ""}${interaction === "manual" ? "-zero-risk" : ""}`);
      expect(result.tunnelReady).not.toBe(true);
      expect(result.connectorSetupRequired).toBe(true);
      expect(saved?.experimentalFreshConversationPerTurn).toBe(interaction === "automatic");
      expect(saved?.useSavedChats).toBe(true);

      calls.length = 0;
      mocks.push(spyOn(configModule, "saveConfig").mockImplementation(() => { throw new Error("config commit failed"); }));
      await expect((development ? setupDevProfile : setup)({ ...options, port })).rejects.toThrow("config commit failed");
      expect(calls).toEqual([]);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform !== "darwin")("external service setup retains validation cleanup on success and failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-external-setup-"));
  const configPath = join(root, "config.json");
  const key = join(root, "runtime.key");
  writeFileSync(key, "fixture-runtime-key");
  writeFileSync(configPath, "{}");
  const existing = {
    ...configModule.defaultConfig("full"),
    subagentProtocol: "native" as const,
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({
    service: "codex-chatgpt-web", status: "ok", mode: "full", version: existing.releaseVersion, accepting_turns: true,
  }) });
  existing.port = proxy.port!;
  const calls: string[] = [];
  let ready = true;
  let stopFails = false;
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockReturnValue(existing),
    spyOn(configModule, "saveConfig").mockImplementation(() => {}),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
    spyOn(browserLogin, "browserLoginStateExists").mockReturnValue(true),
    spyOn(browserLogin, "storedBrowserLoginCapabilities").mockReturnValue({ solAvailable: true, extraHighAvailable: false, proAvailable: false } as never),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "assertServiceIdle").mockResolvedValue(undefined),
    spyOn(service, "installService").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "restartService").mockResolvedValue({ installed: true, loaded: true } as never),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnelService, "installTunnelService").mockImplementation(() => { calls.push("service"); return { installed: true, loaded: true } as never; }),
    spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
    spyOn(tunnel, "connectTunnel").mockImplementation(() => { calls.push("connect"); }),
    spyOn(tunnel, "waitForTunnelReady").mockImplementation(async () => { calls.push("ready"); return { ok: ready, detail: "fixture readiness" } as never; }),
    spyOn(tunnel, "stopTunnel").mockImplementation(() => {
      calls.push("stop");
      if (stopFails) throw new Error("fixture stop failure");
    }),
  ];
  try {
    const options = { mode: "full" as const, subagentProtocol: "native" as const, tunnelId: `tunnel_${"b".repeat(32)}`, restartService: true };
    expect((await setup(options)).tunnelReady).toBe(true);
    expect(calls).toEqual(["connect", "ready", "stop", "service", "ready"]);
    ready = false;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("did not become healthy and ready");
    expect(calls).toEqual(["connect", "ready", "stop"]);
    stopFails = true;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("fixture readiness; temporary tunnel cleanup also failed: fixture stop failure");
    expect(calls).toEqual(["connect", "ready", "stop"]);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    await proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
