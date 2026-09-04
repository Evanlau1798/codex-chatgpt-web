import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lifecycleAutoCompactTokenLimit } from "../scripts/lifecycle-smoke/codex-app-server";
import { catalogContainsModel, childTtlResumePrompt, codexLifecycleModel, manualCompactionContinuedSafely } from "../scripts/lifecycle-smoke/codex-lane";
import { hasLocalFileEvidence } from "../scripts/lifecycle-smoke/skill-contract";
import { ownedSurfaceEvents } from "../scripts/lifecycle-smoke/codex-v2-surfaces";

test("Codex child TTL prompt names the exact existing agent and required tool", () => {
  const prompt = childTtlResumePrompt("grandchild-thread-id");

  expect(prompt).toContain("send_input");
  expect(prompt).toContain("target=grandchild-thread-id");
  expect(prompt).toContain("Do not dispatch another subagent");
});

test("Codex lifecycle smoke forces compaction within bounded read-only review work", () => {
  expect(lifecycleAutoCompactTokenLimit).toBe(70_000);
});

test("Codex live lanes keep Pro selected through hierarchy and resume", () => {
  expect(codexLifecycleModel).toBe("chatgpt-web/pro");
  for (const name of ["codex-lane", "codex-v2-scenario"]) {
    const source = readFileSync(new URL(`../scripts/lifecycle-smoke/${name}.ts`, import.meta.url), "utf8");
    expect(source).toContain('effort: "ultra"');
    expect(source).not.toContain('"xhigh"');
    expect(source).not.toContain('"chatgpt-web/extra-high"');
  }
});

test("Codex lifecycle provider reuses the signed-in Codex OAuth token", () => {
  const source = readFileSync(new URL("../scripts/lifecycle-smoke/codex-app-server.ts", import.meta.url), "utf8");

  expect(source).toContain("model_providers.lifecycle_smoke.requires_openai_auth=true");
});

test("Codex catalog preflight accepts an already-cached Web model", () => {
  expect(catalogContainsModel({ data: [{ id: "chatgpt-web/extra-high" }] }, "chatgpt-web/extra-high"))
    .toBeTrue();
  expect(catalogContainsModel({ data: [{ id: "gpt-5.6-sol" }] }, "chatgpt-web/extra-high"))
    .toBeFalse();
});

test("Codex local evidence accepts conventional L-prefixed line references", () => {
  const target = "G:\\repo\\tests\\target.test.ts";
  expect(hasLocalFileEvidence([{
    method: "item/completed",
    params: {
      turnId: "turn",
      item: { type: "commandExecution", command: `Get-Content '${target}'`, status: "completed" },
    },
  }], "turn", target, "The replacement boundary is at L38; persistence is covered at L51–77.")).toBeTrue();
});

test("Codex local evidence accepts plural line ranges", () => {
  const target = "G:\\repo\\tests\\target.test.ts";
  expect(hasLocalFileEvidence([{
    method: "item/completed",
    params: {
      turnId: "turn",
      item: { type: "commandExecution", command: `Get-Content '${target}'`, status: "completed" },
    },
  }], "turn", target, "The checks are at lines 38–49 and lines 51–77.")).toBeTrue();
});

test("Codex root ownership follows same-trace replacement tabs", () => {
  const launcher = [
    { at: "2026-01-01T00:00:00.000Z", event: "browser.tab_reused", detail: { tabId: "root-old", traceId: "trace-a" } },
    { at: "2026-01-01T00:00:01.000Z", event: "browser.tab_created", detail: { tabId: "root-new", traceId: "trace-a" } },
    { at: "2026-01-01T00:00:02.000Z", event: "browser.tab_reused", detail: { tabId: "root-new", traceId: "trace-b" } },
    { at: "2026-01-01T00:00:03.000Z", event: "browser.tab_created", detail: { tabId: "child", traceId: "trace-child" } },
  ] as any;

  expect(ownedSurfaceEvents(launcher, ["root-old"], ["trace-a"]).map(value => value.detail?.tabId))
    .toEqual(["root-old", "root-new", "root-new"]);
});

test("manual compaction accepts one completed same-trace surface recovery", () => {
  const launcher = [
    { at: "2026-01-01T00:00:00.000Z", event: "browser.tab_reused", detail: { tabId: "root", traceId: "compact" } },
    { at: "2026-01-01T00:01:00.000Z", event: "browser.tab_released", detail: { tabId: "root", traceId: "compact", status: "error" } },
    { at: "2026-01-01T00:01:00.001Z", event: "browser.turn_ended", detail: { traceId: "compact", status: "failed" } },
    { at: "2026-01-01T00:01:00.002Z", event: "browser.tab_created", detail: { tabId: "replacement", traceId: "compact" } },
    { at: "2026-01-01T00:02:00.000Z", event: "browser.tab_completed", detail: { tabId: "replacement", traceId: "compact" } },
    { at: "2026-01-01T00:02:00.001Z", event: "browser.turn_ended", detail: { traceId: "compact", status: "completed" } },
  ] as any;

  expect(manualCompactionContinuedSafely(launcher, "root")).toBeTrue();
  expect(manualCompactionContinuedSafely(launcher.filter((value: { event: string }) => value.event !== "browser.tab_completed"), "root"))
    .toBeFalse();
});
