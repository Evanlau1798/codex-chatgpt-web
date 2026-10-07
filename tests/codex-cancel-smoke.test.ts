import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Only the external CLI and clock are controlled; the real smoke owns HTTP/SSE,
// cancellation assertions, process watchdogs and cleanup in an isolated Bun process.
for (const scenario of ["slow-startup", "slow-cancellation", "startup-stall"] as const) {
  test(`cancellation smoke distinguishes ${scenario} from provider cancellation latency`, async () => {
    const script = new URL("../scripts/smoke-codex-cancel.ts", import.meta.url);
    const scratch = join(import.meta.dir, "..", "tmp");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "cancel-smoke-worker-"));
    const worker = join(root, "worker.ts");
    // defaultConfig intentionally rejects evaluated Bun entry points on POSIX.
    writeFileSync(worker, `
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      const scenario = ${JSON.stringify(scenario)};
      const realNow = Date.now;
      let elapsed = 0, requests = 0, kills = 0;
      Date.now = () => realNow() + elapsed;
      process.argv[2] = process.execPath;
      const timers = [];
      const nativeTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, ms, ...args) => {
        if (ms === 15_000 || ms === 30_000) timers.push(ms);
        if (scenario === "startup-stall" && ms === 30_000) queueMicrotask(callback);
        return nativeTimeout(callback, ms, ...args);
      };
      Bun.spawnSync = () => ({ exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({
        models: [{ slug: "gpt-5.6-sol", visibility: "list", priority: 1,
          supported_reasoning_levels: [{ effort: "high", description: "High" }], tool_mode: "function" }]
      })) });
      Bun.spawn = (_command, options) => {
        if (scenario === "startup-stall") {
          let finish;
          return { exited: new Promise(resolve => finish = resolve), stdout: new Blob([]).stream(),
            stderr: new Blob([]).stream(), kill() { kills++; finish(1); } };
        }
        if (scenario === "slow-startup") elapsed += 16_000;
        const config = readFileSync(join(options.env.CODEX_HOME, "config.toml"), "utf8");
        const base = JSON.parse(config.match(/^base_url = (.+)$/m)[1]);
        const exited = (async () => {
          const request = () => { requests++; return fetch(base + "/responses", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}"
          }); };
          await (await request()).text();
          if (scenario === "slow-cancellation") elapsed += 16_000;
          await (await request()).text();
          return 1;
        })();
        return { exited, stdout: new Blob([]).stream(), stderr: new Blob(["client_cancelled"]).stream(),
          kill() { throw new Error("Unexpected real-time watchdog expiry in controlled clock fixture"); } };
      };
      try {
        await import(${JSON.stringify(script.href)});
        console.log(JSON.stringify({ ok: true, requests, timers, kills }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message, requests, timers, kills }));
      }
    `);
    const child = Bun.spawn([process.execPath, worker], { stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(output.trim().split("\n").at(-1)!);
      expect(result.requests).toBe(scenario === "startup-stall" ? 0 : 2);
      if (scenario === "slow-startup") {
        expect(result.ok).toBeTrue();
        expect(output).toContain("NATIVE_CODEX_BROWSER_TAB_CANCEL_SMOKE_OK");
        expect(result.timers).toEqual([30_000, 15_000]);
      } else if (scenario === "slow-cancellation") {
        expect(result.ok).toBeFalse();
        expect(result.error).toContain("cancellation did not terminate within the smoke deadline");
      } else {
        expect(result.ok).toBeFalse();
        expect(result.error).toContain("Codex made 0 Responses requests");
        expect(result.kills).toBe(1);
        expect(result.timers).toEqual([30_000]);
      }
    } finally { clearTimeout(deadline); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
}
