import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { candidateWebConfig } from "../scripts/smoke-candidate-web";
import { defaultConfig } from "../src/config";
import { VERSION } from "../src/version";

test("candidate Web smoke isolates the built daemon while preserving the launcher browser host", () => {
  const current = Object.assign(defaultConfig("full"), {
    releaseVersion: "old",
    port: 17841,
    browserHost: "launcher" as const,
    browserHostDescriptorPath: "C:\\runtime\\launcher-browser.json",
    useEnhancedWebSessionMode: true,
    brokerSocketPath: "old-broker",
    runtimeCommand: ["old-runtime"],
  });
  const config = candidateWebConfig(
    current,
    "C:\\candidate-home",
    24567,
  );

  expect(config).toMatchObject({
    releaseVersion: VERSION,
    host: "127.0.0.1",
    port: 24567,
    browserHost: "launcher",
    browserHostDescriptorPath: "C:\\runtime\\launcher-browser.json",
    useEnhancedWebSessionMode: true,
    runtimeCommand: ["old-runtime"],
  });
  expect(config.brokerSocketPath).not.toBe("old-broker");
});

test("candidate Web smoke drains before shutdown and bounds the live subprocess", () => {
  const script = readFileSync(new URL("../scripts/smoke-candidate-web.ts", import.meta.url), "utf8");
  const drainAt = script.indexOf('control(baseUrl, "drain"');
  const shutdownAt = script.indexOf('control(baseUrl, "shutdown"');
  expect(drainAt).toBeGreaterThan(-1);
  expect(shutdownAt).toBeGreaterThan(drainAt);
  expect(script).toContain("WEB_CONTRACT_PROBE_TIMEOUT_MS + WEB_CONTRACT_TURN_TIMEOUT_MS + 30_000");
  expect(script).toContain("Candidate Web smoke timed out");
});
