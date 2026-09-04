import { expect, test } from "bun:test";
import { defaultConfig, type AppConfig, type TunnelConfig } from "../src/config";
import { meaningfulRuntimeChange, tunnelWorkerRuntimeChanged } from "../src/setup";

const tunnel: TunnelConfig = {
  tunnelId: "tunnel_0123456789abcdef0123456789abcdef", binaryPath: process.execPath,
  runtimeKeyFile: "/fixture/automatic.key", profileDir: "/fixture/profiles",
  profileName: "automatic", alias: "automatic",
};
function baseline(): AppConfig {
  return { ...defaultConfig("full"), browserHost: "launcher", tunnel, automaticTunnel: tunnel };
}

for (const [label, change] of Object.entries({
  "Automatic connector": { automaticAppName: "Custom Automatic" },
  "legacy manual connector migration": { manualAppName: undefined },
  "interaction mode": { browserInteractionMode: "manual" },
  "Zero Risk Pro": { zeroRiskProEnabled: true },
  "inactive manual profile": { manualTunnel: { ...tunnel, tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  "Automatic profile": { automaticTunnel: { ...tunnel, profileName: "replacement" } },
})) {
  test(`setup detects ${label} as a meaningful runtime change`, () => {
    const before = baseline();
    expect(meaningfulRuntimeChange(before, { ...before, ...change } as AppConfig)).toBe(true);
  });
}

test("tunnel worker refreshes for interaction mode changes at the same version", () => {
  const before = baseline();
  expect(tunnelWorkerRuntimeChanged(before, { ...before, browserInteractionMode: "manual" })).toBe(true);
});

test("tunnel worker refreshes for active profile changes at the same version", () => {
  const before = baseline();
  expect(tunnelWorkerRuntimeChanged(before, { ...before, tunnel: { ...tunnel, alias: "new-alias" } })).toBe(true);
});

test("unchanged settings and inactive profile edits do not refresh the active tunnel worker", () => {
  const before = baseline();
  const after = structuredClone(before);
  expect(meaningfulRuntimeChange(before, after)).toBe(false);
  expect(tunnelWorkerRuntimeChanged(before, after)).toBe(false);
  after.manualTunnel = { ...tunnel, alias: "inactive" };
  expect(tunnelWorkerRuntimeChanged(before, after)).toBe(false);
  expect(tunnelWorkerRuntimeChanged(undefined, after)).toBe(false);
  expect(tunnelWorkerRuntimeChanged({ ...before, mode: "browser-only" }, after)).toBe(false);
  expect(tunnelWorkerRuntimeChanged(before, { ...after, mode: "browser-only" })).toBe(false);
});
