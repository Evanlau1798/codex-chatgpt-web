import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleArtifactEncoder, LifecycleMemoryBudget } from "../scripts/lifecycle-smoke/artifacts";
import { ClaudeRun } from "../scripts/lifecycle-smoke/claude-lane";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true }); });

test("Claude rejects a result followed by protocol overflow in the same chunk", async () => {
  const output = join(tmpdir(), `lifecycle-claude-run-${crypto.randomUUID()}.jsonl`);
  paths.push(output);
  const run = Object.create(ClaudeRun.prototype) as any;
  run.output = output;
  run.records = [];
  run.receivedAt = [];
  run.results = 0;
  run.buffer = "";
  run.waiters = new Set();
  run.outputEncoder = new LifecycleArtifactEncoder();
  run.memoryBudget = new LifecycleMemoryBudget({ maxLineBytes: 128, maxTotalBytes: 512 });
  run.process = {
    stdout: new Blob([
      `${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n${"x".repeat(200)}\n`,
    ]).stream(),
    kill: () => {},
  };

  const read = run.readOutput().catch((error: Error) => { run.readFailure = error; });
  const result = run.waitResult(1, 100);
  await read;
  await expect(result).rejects.toThrow("line limit");
});
