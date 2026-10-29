import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCancellationSmoke } from "../scripts/smoke-codex-cancel";

for (const [mode, error] of [
  ["slow-start", null],
  ["never-start", /startup did not reach/],
  ["hang-after-cancel", /cancellation did not terminate/],
  ["success-exit", /reported cancellation as success/],
  ["missing-replay", /made 1 Responses requests/],
] as const) {
  test(`native cancellation smoke: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-smoke-test-"));
    const fixture = join(root, "codex.ts");
    const receipt = join(root, "receipt.json");
    writeFileSync(fixture, `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.argv[2];
if (process.argv[4] === "debug") {
  console.log(JSON.stringify({ models: [{ slug: "gpt-6-sol", visibility: "list",
    supported_reasoning_levels: [{ effort: "high", description: "High" }] }] }));
  process.exit(0);
}
writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, root: process.cwd() }));
const config = Bun.TOML.parse(readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8"));
const url = config.model_providers["cancel-smoke"].base_url + "/responses";
if (mode === "never-start") await Bun.sleep(60_000);
if (mode === "slow-start") await Bun.sleep(800);
const send = async () => (await fetch(url, { method: "POST", body: "{}" })).text();
console.log(await send());
if (mode === "hang-after-cancel") await Bun.sleep(60_000);
if (mode !== "missing-replay") console.log(await send());
process.exit(mode === "success-exit" ? 0 : 1);
`);
    try {
      const run = runCancellationSmoke([process.execPath, fixture, mode, receipt], {
        startupMs: mode === "never-start" ? 500 : 5_000,
        cancellationMs: 500,
        outputMs: 1_000,
      });
      if (error) await expect(run).rejects.toThrow(error);
      else await run;
      const child = JSON.parse(readFileSync(receipt, "utf8"));
      expect(existsSync(child.root)).toBe(false);
      expect(() => process.kill(child.pid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
