import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("browser cancellation owns rejected operations even when already aborted", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/runtime-lifecycle.ts", import.meta.url), "utf8");
  const start = source.indexOf("function abortError()");
  const end = source.indexOf("\nexport type ChatGptSurfaceRecoveryReason", start);
  expect(start).toBeGreaterThan(0);
  const helper = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(
    source.slice(start, end).replace("export function withAbort", "function withAbort")
      + "\nconst withBrowserTurnAbort = withAbort;",
  );
  // The packaged helper runs on Node: test process survival, not just the caught
  // outer error. Bun and Node can handle unowned rejections differently.
  const child = spawnSync("node", ["--unhandled-rejections=strict", "-e", helper + `
    const assert = require('node:assert/strict');
    (async () => {
      for (const preAborted of [true, false]) {
        const controller = new AbortController();
        if (preAborted) controller.abort();
        const operation = new Promise((_, reject) => setTimeout(() => reject(
          new DOMException('ChatGPT external progress wait aborted', 'AbortError')), 10));
        const waiting = withBrowserTurnAbort(Promise.race([operation]), controller.signal);
        if (!preAborted) controller.abort();
        await assert.rejects(waiting, { name: 'AbortError', message: 'ChatGPT web turn aborted' });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await assert.rejects(withBrowserTurnAbort(Promise.reject(new Error('real failure')),
        new AbortController().signal), /real failure/);
      assert.equal(await withBrowserTurnAbort(Promise.resolve('another task')), 'another task');
      console.log('CANCELLATION_ISOLATED');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8", timeout: 10_000 });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout).toContain("CANCELLATION_ISOLATED");
});
