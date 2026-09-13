import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

test("Codex live lanes keep High selected through hierarchy and resume", () => {
  expect(codexLifecycleModel).toBe("chatgpt-web/high");
  for (const name of ["codex-lane", "codex-v2-scenario"]) {
    const source = readFileSync(new URL(`../scripts/lifecycle-smoke/${name}.ts`, import.meta.url), "utf8");
    expect(source).toContain('effort: "high"');
    expect(source).not.toContain('"ultra"');
    expect(source).not.toContain('"chatgpt-web/pro"');
    expect(source).not.toContain('"xhigh"');
    expect(source).not.toContain('"chatgpt-web/extra-high"');
  }
});

test("Codex audits the active steering turn and cleans up before any work after a failed audit", async () => {
  const tmp = join(import.meta.dir, "..", "tmp");
  mkdirSync(tmp, { recursive: true });
  const directory = mkdtempSync(join(tmp, "offline-steering-audit-"));
  const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", name));
  try {
    for (const valid of [false, true]) {
      const audit = valid
        ? "1. Appended to a tool result.\n2. One literal occurrence.\n3. None of those."
        : "1. Earlier guidance is unavailable.\n2. Cannot verify the count.\n3. Cannot verify controls.";
      const child = Bun.spawn([process.execPath, "--eval", `
        import { mock } from "bun:test";
        const common = await import(${modulePath("common.ts")});
        const app = await import(${modulePath("codex-app-server.ts")});
        const skills = await import(${modulePath("skill-contract.ts")});
        const artifacts = await import(${modulePath("artifacts.ts")});
        const calls = { starts: 0, closed: 0, cutoffs: 0, steering: "" };
        const text = "https://developers.openai.com/api/docs/\\n" + ${JSON.stringify(audit)};
        class FakeRun {
          received = [];
          async initialize() {}
          async request(method, params) {
            if (method === "config/read") return { config: { model_auto_compact_token_limit: app.lifecycleAutoCompactTokenLimit } };
            if (method === "model/list") return { data: [{ id: "chatgpt-web/high" }, { id: "chatgpt-web/pro" }] };
            if (method === "thread/start") return { thread: { id: "root" } };
            if (method === "turn/steer") { calls.steering = params.input[0].text; return {}; }
            if (method === "turn/start") {
              if (++calls.starts > 1) throw new Error("Bounded fixture: later work reached");
              this.received = ["commandExecution", "agentMessage"].map(type => ({
                method: "item/completed", params: { threadId: "root", turnId: "initial",
                  item: { type, phase: "final_answer", text } } }));
              return { turn: { id: "initial" } };
            }
            throw new Error("Unexpected fixture request: " + method);
          }
          messages() { return [text]; }
          firstClientTimes() { return {}; }
          compactions() { return 0; }
          async close() { calls.closed++; }
        }
        const surface = event => ({ at: new Date().toISOString(), event, detail: { tabId: "owned", traceId: "trace" } });
        mock.module(${modulePath("common.ts")}, () => ({ ...common,
          serviceBaseUrl: () => "http://127.0.0.1:1",
          waitCreateBudget: async () => {}, waitRootRequestBudget: async () => {},
          waitForEvent: async () => surface("browser.tab_created"), waitSteeringPoint: async () => true,
          events: () => [surface("browser.tab_created"), surface("browser.tab_retained")],
          cutoff: async () => { calls.cutoffs++; }, save: async () => {} }));
        mock.module(${modulePath("codex-app-server.ts")}, () => ({ ...app, CodexRun: FakeRun, completed: async () => {} }));
        mock.module(${modulePath("skill-contract.ts")}, () => ({ ...skills, hasLocalFileEvidence: () => true,
          skillContractEvidence: () => ({ archiveTransport: true, archiveComplete: true, firstWorkWasSkillRead: true,
            skillReadAfterArchive: true, skillReadComplete: true }) }));
        mock.module(${modulePath("artifacts.ts")}, () => ({ ...artifacts, saveLifecycleContentSummary: () => {} }));
        globalThis.fetch = async () => Response.json({ successful_model_catalog_requests: 1 });
        const { runCodexLane } = await import(${modulePath("codex-lane.ts")});
        const result = await runCodexLane(${JSON.stringify(directory)});
        console.log(JSON.stringify({ calls, checks: result.checks }));
      `], { stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CODEX_CHATGPT_WEB_HOME: join(directory, "unconfigured-home") } });
      const deadline = setTimeout(() => child.kill(), 5000);
      try {
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(errors).toBe("");
        expect(code).toBe(0);
        const result = JSON.parse(output.trim());
        expect(result.calls.steering).toContain("Audit only the earlier lifecycle steering guidance");
        expect(result.calls.starts).toBe(valid ? 2 : 1);
        expect(result.checks.steering_audit_exact_once).toBe(valid);
        expect(result.calls.closed).toBe(1);
        expect(result.calls.cutoffs).toBe(1);
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
