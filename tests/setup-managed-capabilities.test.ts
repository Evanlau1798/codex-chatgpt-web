import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Execute the actual setup capability phase, without platform installation or account access.
const source = readFileSync(resolve(import.meta.dir, "../src/setup.ts"), "utf8");
const begin = source.indexOf("  let loginCreated = false;");
const end = source.indexOf("  const explicitTunnelChange", begin);
if (begin < 0 || end <= begin) throw new Error("Setup capability phase was not found");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function probe(context) {
  const { config, existing, options, beforeService, storedBrowserLoginCapabilities,
    browserLoginStateExists, inspectBrowserLoginCapabilities, inspectLauncherCapabilities,
    loginToChatGpt, assertServiceIdle } = context;
  ${source.slice(begin, end)}
  return config;
}`);
const probe = new Function(`${javascript}; return probe;`)() as (context: Record<string, unknown>) => Promise<{
  solAvailable: boolean; proAvailable: boolean;
}>;

test.each(["automatic", "manual"])("managed Automatic re-entry refreshes only prior manual capabilities: %s", async prior => {
  const calls: string[] = [];
  const result = await probe({
    config: { browserHost: "managed-chrome", browserInteractionMode: "automatic" },
    existing: { browserInteractionMode: prior }, options: {}, beforeService: { loaded: false },
    storedBrowserLoginCapabilities: () => ({ solAvailable: true, proAvailable: true }),
    browserLoginStateExists: () => true,
    inspectBrowserLoginCapabilities: async () => { calls.push("inspect"); return { solAvailable: true, proAvailable: false }; },
    loginToChatGpt: async () => { throw new Error("Verified login must not be replaced"); },
  });
  expect(calls).toEqual(prior === "manual" ? ["inspect"] : []);
  expect(result.proAvailable).toBe(prior === "automatic");
});

test("manual setup capability phase never reads stored or live browser state", async () => {
  const forbidden = () => { throw new Error("Manual setup must not inspect the browser"); };
  await expect(probe({
    config: { browserHost: "launcher", browserInteractionMode: "manual", solAvailable: true, proAvailable: true },
    existing: { browserInteractionMode: "automatic" }, options: {}, beforeService: { loaded: false },
    storedBrowserLoginCapabilities: forbidden, browserLoginStateExists: forbidden,
    inspectBrowserLoginCapabilities: forbidden, inspectLauncherCapabilities: forbidden, loginToChatGpt: forbidden,
  })).resolves.toMatchObject({ solAvailable: true, proAvailable: true });
});
