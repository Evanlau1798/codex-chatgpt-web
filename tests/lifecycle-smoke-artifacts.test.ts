import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleArtifactEncoder,
  LifecycleMemoryBudget,
  readBoundedLifecycleProcess,
  lifecycleErrorCategory,
  saveLifecycleContentSummary,
  saveLifecycleJson,
  saveRedactedLifecycleJson,
  readBoundedLifecycleStream,
  summarizeClaudeRecord,
  summarizeCodexRpc,
} from "../scripts/lifecycle-smoke/artifacts";
import { skillContractEvidence } from "../scripts/lifecycle-smoke/skill-contract";

test("raw lifecycle summaries retain structure without prompt, answer, or tool content", () => {
  const secret = "PRIVATE_PROMPT_AND_ANSWER";
  const claude = JSON.stringify(summarizeClaudeRecord({
    type: "assistant",
    subtype: "success",
    result: secret,
    message: { content: [{ type: "text", text: secret }, { type: "tool_use", input: secret }] },
  }, "2026-01-01T00:00:00.000Z"));
  const codex = JSON.stringify(summarizeCodexRpc({
    method: "item/agentMessage/delta",
    params: { delta: secret, item: { type: "agentMessage", text: secret } },
  }, "2026-01-01T00:00:00.000Z"));

  expect(claude).not.toContain(secret);
  expect(codex).not.toContain(secret);
  expect(claude).toContain('"textChars":25');
  expect(codex).toContain('"deltaChars":25');
});

test("lifecycle protocol memory rejects oversized lines, totals, and command output", async () => {
  const budget = new LifecycleMemoryBudget({ maxLineBytes: 8, maxTotalBytes: 12 });
  budget.retain("12345678", "rpc");
  expect(() => budget.retain("123456789", "rpc")).toThrow("line limit");
  expect(() => budget.retain("12345", "rpc")).toThrow("memory limit");
  const stream = new Blob(["x".repeat(20)]).stream();
  await expect(readBoundedLifecycleStream(stream, 10, "command stdout")).rejects.toThrow("memory limit");
});

test("bounded lifecycle process output terminates its child on overflow", async () => {
  let killed = false;
  const child = {
    stdout: new Blob(["x".repeat(20)]).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(1),
    kill: () => { killed = true; },
  };
  await expect(readBoundedLifecycleProcess(child, Promise.resolve(1), 10, "command"))
    .rejects.toThrow("memory limit");
  expect(killed).toBeTrue();
});

test("lifecycle failure categories never retain model or tool content", () => {
  const secret = "PRIVATE_FAILURE_MODEL_CONTENT";
  expect(lifecycleErrorCategory(new Error(secret))).toBe("LIFECYCLE_SMOKE_FAILED");
  expect(lifecycleErrorCategory(new Error(`RATE_OR_VERIFICATION_LIMIT: ${secret}`)))
    .toBe("RATE_OR_VERIFICATION_LIMIT");
});

test("retained lifecycle evidence is content-free, owner-only, and bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-artifacts-"));
  const secret = "PRIVATE_MODEL_AND_TOOL_CONTENT";
  try {
    const summary = join(root, "summary.json");
    const redacted = join(root, "redacted.json");
    const bounded = join(root, "bounded.json");
    saveLifecycleContentSummary(summary, "final", secret);
    saveRedactedLifecycleJson(redacted, { prompt: secret, nested: [{ result: secret }] });
    saveLifecycleJson(bounded, { value: secret.repeat(100_000) });

    for (const path of [summary, redacted, bounded]) {
      expect(readFileSync(path, "utf8")).not.toContain(secret);
      expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle JSONL encoding has per-record and total byte ceilings", () => {
  const encoder = new LifecycleArtifactEncoder({ maxLineBytes: 96, maxTotalBytes: 240 });
  const outputs = Array.from({ length: 20 }, (_, index) => encoder.encode({
    type: "record",
    index,
    detail: "x".repeat(200),
  })).filter((value): value is string => value !== undefined);
  const bytes = outputs.reduce((total, value) => total + Buffer.byteLength(value), 0);

  expect(bytes).toBeLessThanOrEqual(240);
  expect(outputs.every(value => Buffer.byteLength(value) <= 96)).toBeTrue();
  expect(outputs.join("")).not.toContain("x".repeat(20));
});

test("skill contract artifacts never retain an absolute user path", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-skill-path-"));
  try {
    const skillDir = join(root, "openai-docs");
    const skillPath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, "# Test skill\n", "utf8");

    const artifact = JSON.stringify(skillContractEvidence([], [], "turn", "trace", skillPath));
    expect(artifact).not.toContain(root);
    expect(artifact).toContain('"skillName":"openai-docs"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
