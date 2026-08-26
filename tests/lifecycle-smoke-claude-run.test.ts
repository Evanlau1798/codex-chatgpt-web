import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleArtifactEncoder, LifecycleMemoryBudget } from "../scripts/lifecycle-smoke/artifacts";
import { ClaudeRun } from "../scripts/lifecycle-smoke/claude-lane";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true }); });

test("Claude close rejects protocol overflow arriving after a result chunk", async () => {
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
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  run.process = {
    stdout: new ReadableStream({ start(value) { controller = value; } }),
    stdin: { end: () => {} },
    exited: Promise.resolve(0),
    killed: false,
    kill: () => {},
  };
  run.errorTask = Promise.resolve();
  run.outputTask = run.readOutput();

  controller.enqueue(new TextEncoder().encode(
    `${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`,
  ));
  expect((await run.waitResult(1, 100)).result).toBe("ok");
  controller.enqueue(new TextEncoder().encode(`${"x".repeat(200)}\n`));
  controller.close();
  await expect(run.close()).rejects.toThrow("line limit");
});
