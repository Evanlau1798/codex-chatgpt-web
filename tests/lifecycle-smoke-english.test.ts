import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditPrompt, noSkillInstruction, reviewTaskPrompt, rootRequestCooldownMs, steeringText,
} from "../scripts/lifecycle-smoke/common";
import { hierarchyPrompt, selfTestHierarchySurfaceClassification } from "../scripts/lifecycle-smoke/codex-v2-scenario";
import { agentWaitProgressOverlap, selfTestV2ActivityNormalization } from "../scripts/lifecycle-smoke/codex-v2-activity";

test("lifecycle smoke scripts contain no CJK prompt or validation text", () => {
  const root = join(import.meta.dir, "..", "scripts", "lifecycle-smoke");
  const offenders = readdirSync(root)
    .filter(name => name.endsWith(".ts"))
    .filter(name => /[\u3400-\u9fff]/u.test(readFileSync(join(root, name), "utf8")));

  expect(offenders).toEqual([]);
});

test("Claude TTL resume names and verifies the existing child identity", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("agent ID ${childId}");
  expect(source).toContain("resumedChildId === childId");
});

test("Claude child interaction verifies the requested final test name", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("finds Markdown restoration markers strictly right-to-left");
});

test("the English steering marker continues instead of replacing the active task", () => {
  expect(steeringText).toContain("Respond only in English");
  expect(steeringText).toContain("continue the original task");
  expect(steeringText.toLowerCase()).not.toContain("acknowledge");
});

test("the steering audit requires stable numbered answer labels", () => {
  expect(auditPrompt).toContain('Use exactly the labels "1." through "3."');
  expect(auditPrompt).toContain("Do not use blockquotes");
  expect(auditPrompt).toContain('If none apply, write exactly: "None of those."');
});

test("Claude audits steering inside the same active turn", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("`${steeringText}\\n\\n${auditPrompt}`");
  expect(source).not.toContain('new ClaudeRun(join(laneRoot, "steering-audit.jsonl")');
});

test("root lifecycle resumes use a one-minute cooldown", () => {
  expect(rootRequestCooldownMs).toBe(60_000);
});

test("bounded review rounds do not open unrelated skill surfaces", () => {
  expect(reviewTaskPrompt).toContain(noSkillInstruction);
  for (const name of ["claude-lane.ts", "codex-lane.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", name), "utf8");
    expect(source).toContain("${noSkillInstruction}");
  }
});

test("the hierarchy root follows the transport-safe agent wait contract", () => {
  expect(hierarchyPrompt).toContain("Use chatgpt-web/high with high reasoning effort for both descendants.");
  expect(hierarchyPrompt).toContain("one blocking read-only wait");
  expect(hierarchyPrompt).toContain("must not call send_input to address the root");
  expect(hierarchyPrompt).toContain("timeout_ms=30000");
  expect(hierarchyPrompt).toContain("repeat the same wait_agent call");
  expect(hierarchyPrompt).not.toContain("must not poll wait_agent");
  expect(hierarchyPrompt).toContain("complete before the child follow-up");
  expect(hierarchyPrompt).toContain("exactly six consecutive wait_agent calls");
  expect(hierarchyPrompt).toContain("Immediately after the sixth timeout");
  expect(hierarchyPrompt).toContain("interrupt=true exactly once");
  expect(hierarchyPrompt).toContain("close_agent exactly once");
  expect(hierarchyPrompt).toContain("completed grandchild");
});

test("steering accepts native work without DOM visibility and rejects an already completed turn", async () => {
  const root = join(import.meta.dir, "..", "tmp");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "steering-boundary-"));
  const log = join(directory, "launcher.jsonl");
  const common = join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "common.ts");
  const work = { at: new Date().toISOString(), event: "runtime.daemon_stdout",
    detail: { line: "[chatgpt-web] broker trace=owned queued call=call_test tool=exec_command" } };
  try {
    for (const completed of [false, true]) {
      writeFileSync(log, [work, ...(completed ? [{ at: new Date().toISOString(),
        event: "browser.tab_completed", detail: { traceId: "owned" } }] : [])]
        .map(value => JSON.stringify(value)).join("\n") + "\n");
      const child = Bun.spawn([process.execPath, "--eval", `
        const { waitSteeringPoint } = await import(${JSON.stringify(common)});
        try { console.log(await waitSteeringPoint(0, "owned", 1000) ? "ready" : "not-ready"); }
        catch (error) { console.log(error.message); }
      `], { env: { ...process.env, CODEX_LIFECYCLE_LAUNCHER_LOG: log }, stdout: "pipe", stderr: "pipe" });
      const deadline = setTimeout(() => child.kill(), 2000);
      try {
        const [output, errors] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(errors).toBe("");
        expect(output.trim()).toBe(completed ? "Web turn completed before a steering delivery point" : "ready");
      } finally {
        clearTimeout(deadline);
        child.kill();
        await child.exited;
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wait overlap requires child progress inside a completed parent wait interval", () => {
  const event = (second: number, line: string) => ({ at: `2026-01-01T00:00:0${second}.000Z`,
    event: "runtime.daemon_stdout", detail: { line: `[chatgpt-web] broker ${line}` } });
  const start = event(1, "trace=root agent wait receipt");
  const child = event(2, "trace=child served context chunk=1/2");
  const end = event(3, "trace=root agent wait ready elapsedMs=2000");
  const startupEnd = Date.parse(child.at);
  expect(agentWaitProgressOverlap([start, child, end], "root", "child", startupEnd)).toBe(true);
  expect(agentWaitProgressOverlap([child, start, end], "root", "child", startupEnd)).toBe(false);
  expect(agentWaitProgressOverlap([start, child], "root", "child", startupEnd)).toBe(false);
  expect(agentWaitProgressOverlap([start, child, end], "root", "foreign", startupEnd)).toBe(false);
  const followUp = [event(4, "trace=root agent wait receipt"),
    event(5, "trace=child output accepted kind=commentary sequence=2"),
    event(6, "trace=root agent wait ready elapsedMs=2000")];
  expect(agentWaitProgressOverlap([start, end, ...followUp], "root", "child", startupEnd)).toBe(false);
  expect(agentWaitProgressOverlap([start, followUp[1]!, followUp[2]!], "root", "child", startupEnd)).toBe(false);
  expect(agentWaitProgressOverlap([start, child, end], "root", "child", NaN)).toBe(false);
});

test("hierarchy surface accounting accepts only the planned interrupt replacement", () => {
  selfTestHierarchySurfaceClassification();
});

test("targeted interrupt remains distinct from subtree close", () => {
  selfTestV2ActivityNormalization();
});
