import { expect, test } from "bun:test";
import {
  launcherCapabilityProbeRequired,
  setupIntegrationSelection,
  setupProxyIsReady,
} from "../src/setup";

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

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
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
