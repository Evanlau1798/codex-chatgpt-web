import { join } from "node:path";
import { activeTurnSmokeTimeoutMs, CodexRun, completed, Rpc } from "./codex-app-server";
import { assert, detectRestriction, events, iso, repo, repoTests, save } from "./common";
import { normalizeV2Activities, type V2Activity } from "./codex-v2-activity";
import { lifecycleErrorCategory, saveLifecycleContentSummary, saveRedactedLifecycleJson } from "./artifacts";
import {
  activeBrowserTraceIds,
  classifyHierarchySurfaces,
  excludeLauncherTraces,
  latestSurfaceTabForTrace,
  safeSurfaceRecoveryCount,
} from "./codex-v2-surfaces";

export const hierarchySentinel = "V2_HIERARCHY_SMOKE_DONE";

export const hierarchyPrompt = `Respond only in English. Validate one hierarchical Multi-Agent collaboration flow while remaining read-only: do not modify files, run tests, or use the network. Limit all work to ${repoTests}.

First read one relevant test file yourself, then dispatch exactly one child. Ask the child to read another relevant test file, wait long enough that adjacent Web session creations are at least 30 seconds apart, and then have the child dispatch exactly one grandchild. After the child successfully creates the grandchild, it must not wait for the grandchild; it must immediately complete its current turn and report the grandchild agent ID plus file evidence so the root obtains that identity through the normal wait result. The grandchild must perform one small read-only probe, provide verifiable file evidence, and report actual friction.

The root must first wait until the child's completion result explicitly reports successful grandchild creation and its agent ID. Do not send a message to either descendant before seeing that creation evidence. After obtaining both identities, proactively ask each descendant one distinct question. The child follow-up must require it to publish its evidence as commentary, must not call send_input to address the root, and then start exactly one blocking wait long enough for the root to interrupt it; it must not poll or call write_stdin after that wait starts. The root may use at most one long wait_agent call for descendant delivery and must not poll wait_agent. After receiving both interaction records, proactively interrupt the still-running child. The grandchild must complete normally. Finally, confirm that no agent remains running and summarize the root-to-child-to-grandchild identities, two interactions, one interruption, grandchild evidence, and friction at each level.

Use the available native Multi-Agent tools to complete the entire flow without user intervention. Output only ${hierarchySentinel} on the final line.`;

export type HierarchyScenarioResult = {
  status: "passed" | "failed" | "blocked";
  threadId: string;
  turnId: string;
  finalText: string;
  checks: Record<string, boolean>;
  activities: V2Activity[];
  agents: { root: string; child: string; grandchild: string };
  agentTabs: { root: string; child: string; grandchild: string };
  tabs: string[];
  traces: string[];
  problems: Array<{ check: string; message: string }>;
  descendantCompact?: {
    threadId: string;
    turnId: string;
    compactionsBefore: number;
    compactionsAfter: number;
  };
  message?: string;
};

function completedItems(run: CodexRun, since: number) {
  return run.received.filter(message => message.method === "item/completed"
    && Date.parse(message.receivedAt ?? "") >= since);
}

function activities(run: CodexRun, since: number): V2Activity[] {
  return normalizeV2Activities(run.received, since);
}

function rootFinal(run: CodexRun, threadId: string, turnId: string): string {
  return completedItems(run, 0).flatMap(message => message.params?.threadId === threadId
    && message.params?.turnId === turnId && message.params?.item?.type === "agentMessage"
    && message.params.item.phase === "final_answer"
    ? [String(message.params.item.text ?? "")] : []).join("");
}

function toolLedger(run: CodexRun, since: number) {
  const toolTypes = new Set([
    "commandExecution", "mcpToolCall", "dynamicToolCall", "subAgentActivity", "collabAgentToolCall",
  ]);
  const started = run.received.filter(message => message.method === "item/started"
    && Date.parse(message.receivedAt ?? "") >= since && toolTypes.has(message.params?.item?.type));
  const finished = completedItems(run, since).filter(message => toolTypes.has(message.params?.item?.type));
  const startedIds = started.map(message => String(message.params.item.id));
  const finishedIds = finished.map(message => String(message.params.item.id));
  return {
    started: started.map(message => ({ at: message.receivedAt, threadId: message.params?.threadId, item: message.params?.item })),
    completed: finished.map(message => ({ at: message.receivedAt, threadId: message.params?.threadId, item: message.params?.item })),
    allStartedCompleted: startedIds.every(id => finishedIds.includes(id)),
    duplicateCompleted: finishedIds.length !== new Set(finishedIds).size,
  };
}

function threadTurnStatuses(value: any): string[] {
  return (value?.thread?.turns ?? []).map((turn: any) => String(turn.status ?? ""));
}

function markdownCharsForTrace(since: number, traceId: string): number | null {
  const match = events(since).findLast(value => value.event === "runtime.daemon_stdout"
    && String(value.detail?.line ?? "").includes(`browser turn ${traceId} completed (markdownChars=`))
    ?.detail?.line?.match(/markdownChars=(\d+)/)?.[1];
  return match ? Number(match) : null;
}

function problemList(checks: Record<string, boolean>) {
  return Object.entries(checks).filter(([, passed]) => !passed)
    .map(([check]) => ({ check, message: `Hierarchy smoke check failed: ${check}` }));
}

export function selfTestHierarchySurfaceClassification() {
  const launcher = [
    { at: "2026-01-01T00:00:00.000Z", event: "browser.tab_reused", detail: { tabId: "old-root", traceId: "old-root-trace" } },
    { at: "2026-01-01T00:00:01.000Z", event: "browser.tab_created", detail: { tabId: "new-root", traceId: "new-root-trace" } },
    { at: "2026-01-01T00:00:03.000Z", event: "browser.tab_created", detail: { tabId: "child", traceId: "child-trace" } },
    { at: "2026-01-01T00:00:05.000Z", event: "browser.tab_created", detail: { tabId: "grandchild", traceId: "grandchild-trace" } },
    { at: "2026-01-01T00:00:05.100Z", event: "browser.tab_released", detail: { tabId: "child", traceId: "child-trace", status: "aborted" } },
    { at: "2026-01-01T00:00:05.200Z", event: "browser.tab_created", detail: { tabId: "child-replacement", traceId: "child-interrupt-trace" } },
    { at: "2026-01-01T00:00:06.000Z", event: "browser.tab_created", detail: { tabId: "recovered-root", traceId: "new-root-trace" } },
  ] as ReturnType<typeof events>;
  const classified = classifyHierarchySurfaces(
    launcher,
    Date.parse("2026-01-01T00:00:02.000Z"),
    false,
    1,
    new Set(),
    Date.parse("2026-01-01T00:00:05.050Z"),
  );
  assert(classified.expected, "Retained root replacement should not count as a third descendant");
  assert(classified.rootTrace === "new-root-trace", "Final root trace should follow the replacement surface");
  assert(classified.descendantTabs.join(",") === "child,grandchild,child-replacement", "Hierarchy descendants should include the planned child replacement only");
  const missingInterruptRelease = classifyHierarchySurfaces(
    launcher.filter(value => value.event !== "browser.tab_released"),
    Date.parse("2026-01-01T00:00:02.000Z"), false, 1, new Set(),
    Date.parse("2026-01-01T00:00:05.050Z"),
  );
  assert(!missingInterruptRelease.expected, "An unpaired extra descendant surface must fail closed");

  const foreignActiveTrace = "foreign-active-trace";
  const withForeignActiveRecovery = [
    { at: "2026-01-01T00:00:00.000Z", event: "browser.tab_reused", detail: { tabId: "old-root", traceId: "old-root-trace" } },
    { at: "2026-01-01T00:00:01.000Z", event: "browser.tab_created", detail: { tabId: "new-root", traceId: "new-root-trace" } },
    { at: "2026-01-01T00:00:03.000Z", event: "browser.tab_created", detail: { tabId: "child", traceId: "child-trace" } },
    {
      at: "2026-01-01T00:00:04.000Z",
      event: "runtime.daemon_stderr",
      detail: {
        line: `[chatgpt-web] browser turn ${foreignActiveTrace} surface recovery eligible=true reason=eligible errorName="Error" errorCode="none" generation=0 finalChars=0 canonicalResults=4 unresolvedSuperseded=0 canonicalGeneration=5 canonicalComplete=true canonicalCalls=4 cancelledBeforeCanonical=0 resolvedSuperseded=0`,
      },
    },
    {
      at: "2026-01-01T00:00:04.100Z",
      event: "browser.tab_released",
      detail: { tabId: "foreign-old", traceId: foreignActiveTrace, status: "aborted" },
    },
    {
      at: "2026-01-01T00:00:04.200Z",
      event: "browser.tab_created",
      detail: { tabId: "foreign-new", traceId: foreignActiveTrace },
    },
    { at: "2026-01-01T00:00:05.000Z", event: "browser.tab_created", detail: { tabId: "grandchild", traceId: "grandchild-trace" } },
  ] as ReturnType<typeof events>;
  const foreignActiveTraces = new Set([foreignActiveTrace]);
  const isolatedRecoveries = safeSurfaceRecoveryCount(withForeignActiveRecovery, foreignActiveTraces);
  const isolated = classifyHierarchySurfaces(
    withForeignActiveRecovery,
    Date.parse("2026-01-01T00:00:02.000Z"),
    false,
    isolatedRecoveries,
    foreignActiveTraces,
  );
  assert(isolatedRecoveries === 0, "Foreign active recovery should be excluded from hierarchy recovery accounting");
  assert(isolated.expected, "A pre-existing active trace recovery must not pollute hierarchy surface accounting");

  const active = activeBrowserTraceIds([
    { at: "2026-01-01T00:00:00.000Z", event: "browser.turn_started", detail: { traceId: "foreign" } },
    { at: "2026-01-01T00:00:01.000Z", event: "browser.turn_started", detail: { traceId: "completed" } },
    { at: "2026-01-01T00:00:02.000Z", event: "browser.turn_ended", detail: { traceId: "completed", status: "completed" } },
  ] as ReturnType<typeof events>);
  assert(active.size === 1 && active.has("foreign"), "Active browser trace snapshot should exclude completed turns");

  const ownedRecoveryTrace = "owned-root-trace";
  const ownedRecovery = [
    {
      at: "2026-01-01T00:00:03.500Z",
      event: "runtime.daemon_stderr",
      detail: {
        line: `[chatgpt-web] browser turn ${ownedRecoveryTrace} surface recovery eligible=true reason=eligible errorName="Error" errorCode="none" generation=0 finalChars=0 canonicalResults=4 unresolvedSuperseded=0 canonicalGeneration=5 canonicalComplete=true canonicalCalls=4 cancelledBeforeCanonical=0 resolvedSuperseded=0`,
      },
    },
    {
      at: "2026-01-01T00:00:03.600Z",
      event: "runtime.daemon_stdout",
      detail: { line: `[chatgpt-web] browser turn ${ownedRecoveryTrace} rebuilding tool surface from canonical state` },
    },
    {
      at: "2026-01-01T00:00:03.700Z",
      event: "browser.tab_released",
      detail: { tabId: "old-owned-root", traceId: ownedRecoveryTrace, status: "aborted" },
    },
    {
      at: "2026-01-01T00:00:03.800Z",
      event: "browser.tab_created",
      detail: { tabId: "new-owned-root", traceId: ownedRecoveryTrace },
    },
    {
      at: "2026-01-01T00:00:04.000Z",
      event: "browser.tab_completed",
      detail: { tabId: "new-owned-root", traceId: ownedRecoveryTrace },
    },
  ] as ReturnType<typeof events>;
  assert(
    safeSurfaceRecoveryCount(ownedRecovery) === 1,
    "An eligible recovery should accept the aborted retirement of its failed worker",
  );
  const recoveredHierarchy = [
    {
      at: "2026-01-01T00:00:00.000Z",
      event: "browser.tab_reused",
      detail: { tabId: "old-owned-root", traceId: ownedRecoveryTrace },
    },
    {
      at: "2026-01-01T00:00:02.000Z",
      event: "browser.tab_created",
      detail: { tabId: "child", traceId: "child-trace" },
    },
    ...ownedRecovery,
    {
      at: "2026-01-01T00:00:05.000Z",
      event: "browser.tab_created",
      detail: { tabId: "grandchild", traceId: "grandchild-trace" },
    },
  ] as ReturnType<typeof events>;
  assert(
    classifyHierarchySurfaces(
      recoveredHierarchy,
      Date.parse("2026-01-01T00:00:01.000Z"),
      false,
      safeSurfaceRecoveryCount(recoveredHierarchy),
    ).expected,
    "A bounded root recovery should preserve exactly two hierarchy descendant surfaces",
  );
}

export async function runV2HierarchyScenario(
  run: CodexRun,
  threadId: string,
  artifactRoot: string,
  options: { expectFreshRoot?: boolean } = {},
): Promise<HierarchyScenarioResult> {
  const preexistingActiveTraces = activeBrowserTraceIds(events());
  const startedAt = Date.now();
  let turnId = "";
  try {
    const turn = await run.request("turn/start", {
      threadId,
      effort: "xhigh",
      input: [{ type: "text", text: hierarchyPrompt }],
    });
    turnId = String(turn.turn.id);
    await completed(run, turnId, activeTurnSmokeTimeoutMs);
    const completedAt = Date.now();
    const activity = activities(run, startedAt);
    const rootInteractions = activity.filter(value => value.kind === "interacted" && value.parentThreadId === threadId);
    const interrupts = activity.filter(value => value.kind === "interrupted");
    const spawned = activity.filter(value => value.kind === "started");
    const childCandidates = spawned.filter(value => value.parentThreadId === threadId);
    const childId = childCandidates.length === 1 ? childCandidates[0]!.agentThreadId : "";
    const grandchildCandidates = spawned.filter(value => value.parentThreadId === childId);
    const grandchildId = grandchildCandidates.length === 1 ? grandchildCandidates[0]!.agentThreadId : "";
    const childState = childId ? await run.request("thread/read", { threadId: childId, includeTurns: true }) : undefined;
    const grandchildState = grandchildId ? await run.request("thread/read", { threadId: grandchildId, includeTurns: true }) : undefined;
    const finalText = rootFinal(run, threadId, turnId);
    const launcherAll = events(startedAt).filter(value => Date.parse(value.at) <= completedAt);
    const launcher = excludeLauncherTraces(launcherAll, preexistingActiveTraces);
    detectRestriction(launcher, finalText);
    const firstSpawnAt = spawned.length > 0
      ? Math.min(...spawned.map(value => Date.parse(value.at)))
      : Number.POSITIVE_INFINITY;
    const safeRecoveries = safeSurfaceRecoveryCount(launcher);
    const classifiedSurfaces = classifyHierarchySurfaces(
      launcher,
      firstSpawnAt,
      options.expectFreshRoot,
      safeRecoveries,
      new Set(),
      interrupts.length === 1 ? Date.parse(interrupts[0]!.at) : undefined,
    );
    const { creates, surfaces, rootTrace, descendantTabs } = classifiedSurfaces;
    const tabs = [...new Set(surfaces.flatMap(value => value.detail?.tabId ? [String(value.detail.tabId)] : []))];
    const traces = [...new Set(surfaces.flatMap(value => value.detail?.traceId ? [String(value.detail.traceId)] : []))];
    const agentTabs = {
      root: latestSurfaceTabForTrace(launcher, rootTrace),
      child: descendantTabs[0] ?? "",
      grandchild: descendantTabs[1] ?? "",
    };
    const ledger = toolLedger(run, startedAt);
    const activityIds = activity.map(value => value.id);
    const createTimes = creates.map(value => Date.parse(value.at));
    const createSpacing = createTimes.slice(1).every((at, index) => at - createTimes[index]! >= 30_000);
    const childStatuses = threadTurnStatuses(childState);
    const grandchildStatuses = threadTurnStatuses(grandchildState);
    const rootMarkdownChars = rootTrace ? markdownCharsForTrace(startedAt, rootTrace) : null;
    const diagnostics = launcher.filter(value => /projection|surface recovery|rebuilding tool surface|unresolvedSuperseded/i
      .test(`${value.message ?? ""} ${JSON.stringify(value.detail ?? {})}`));
    const descendantCompactAt = Date.now();
    const descendantCompactionsBefore = grandchildId ? run.compactions(grandchildId) : 0;
    let descendantCompactTurnId = "";
    if (grandchildId) {
      await run.request("thread/resume", {
        threadId: grandchildId,
        cwd: repo,
        model: "chatgpt-web/extra-high",
        approvalPolicy: "never",
        sandbox: "read-only",
      }, 60_000);
      await run.request("thread/compact/start", { threadId: grandchildId }, 60_000);
      const compactItem = await run.waitFor(message => (
        message.method === "item/completed"
          && message.params?.threadId === grandchildId
          && message.params?.item?.type === "contextCompaction"
      ) || (
        message.method === "turn/completed"
          && message.params?.threadId === grandchildId
          && message.params?.turn?.status === "failed"
      ), activeTurnSmokeTimeoutMs, "completed descendant compact item");
      if (compactItem.method === "turn/completed") {
        throw new Error(`Completed descendant compact failed: ${compactItem.params?.turn?.error?.message ?? "unknown error"}`);
      }
      descendantCompactTurnId = String(compactItem.params?.turnId ?? "");
      assert(descendantCompactTurnId, "Completed descendant compact item did not expose a turn identity");
      await run.waitFor(message => message.method === "turn/completed"
        && message.params?.threadId === grandchildId
        && message.params?.turn?.id === descendantCompactTurnId, 60_000, "completed descendant compact turn");
    }
    const descendantCompactionsAfter = grandchildId ? run.compactions(grandchildId) : 0;
    const descendantCompactEvents = events(descendantCompactAt);
    const checks: Record<string, boolean> = {
      root_completed: finalText.trim().length > 0,
      exactly_two_spawns: spawned.length === 2,
      hierarchy_root_child_grandchild: childCandidates.length === 1 && grandchildCandidates.length === 1,
      root_interacted_child: rootInteractions.some(value => value.agentThreadId === childId),
      root_interacted_grandchild: rootInteractions.some(value => value.agentThreadId === grandchildId),
      activity_delivery_exact_once: activityIds.length === new Set(activityIds).size,
      child_interrupted_once: interrupts.length === 1 && interrupts[0]?.parentThreadId === threadId
        && interrupts[0]?.agentThreadId === childId,
      interrupt_after_interactions: interrupts.length === 1 && rootInteractions.length >= 2
        && Date.parse(interrupts[0]!.at) > Math.max(...rootInteractions.map(value => Date.parse(value.at))),
      grandchild_completed: grandchildStatuses.includes("completed"),
      child_not_running: !childStatuses.includes("inProgress") && !childStatuses.includes("running"),
      no_orphan_agents: grandchildStatuses.length > 0 && !grandchildStatuses.includes("inProgress")
        && !grandchildStatuses.includes("running"),
      tool_results_complete: ledger.allStartedCompleted,
      no_duplicate_tool_completion: !ledger.duplicateCompleted,
      expected_web_surfaces: classifiedSurfaces.expected,
      web_session_create_spacing: createSpacing,
      surface_recovery_bounded: safeRecoveries !== undefined,
      no_transport_failure: !launcher.some(value => /legacy compact|invalid, expired, or revoked|web error|tool replay|unresolvedSuperseded=[1-9]/i
        .test(`${value.message ?? ""} ${JSON.stringify(value.detail ?? {})}`)),
      final_sentinel_once: finalText.split(hierarchySentinel).length - 1 === 1
        || finalText.split(hierarchySentinel.replaceAll("_", "\\_")).length - 1 === 1,
      final_projection_exact: rootMarkdownChars !== null && rootMarkdownChars === finalText.length,
      completed_descendant_compacted: Boolean(grandchildId && descendantCompactTurnId
        && descendantCompactionsAfter === descendantCompactionsBefore + 1),
      descendant_compact_token_valid: !descendantCompactEvents.some(value => /invalid, expired, or revoked|turn token|control token/i
        .test(`${value.message ?? ""} ${JSON.stringify(value.detail ?? {})}`)),
    };
    const problems = problemList(checks);
    saveLifecycleContentSummary(join(artifactRoot, "final.json"), "final", finalText);
    saveRedactedLifecycleJson(join(artifactRoot, "agent-activity.json"), activity);
    saveRedactedLifecycleJson(join(artifactRoot, "tool-ledger.json"), ledger);
    saveRedactedLifecycleJson(join(artifactRoot, "thread-states.json"), { child: childState, grandchild: grandchildState });
    await save(join(artifactRoot, "timeline.json"), { startedAt: iso(startedAt), completedAt: iso(completedAt), creates });
    await save(join(artifactRoot, "recovery-projection.json"), diagnostics);
    saveRedactedLifecycleJson(join(artifactRoot, "descendant-compact.json"), {
      threadId: grandchildId,
      turnId: descendantCompactTurnId,
      compactionsBefore: descendantCompactionsBefore,
      compactionsAfter: descendantCompactionsAfter,
      launcher: descendantCompactEvents,
    });
    saveRedactedLifecycleJson(join(artifactRoot, "launcher.json"), launcher);
    saveRedactedLifecycleJson(join(artifactRoot, "problems.json"), problems);
    return {
      status: problems.length === 0 ? "passed" : "failed",
      threadId,
      turnId,
      finalText,
      checks,
      activities: activity,
      agents: { root: threadId, child: childId, grandchild: grandchildId },
      agentTabs,
      tabs,
      traces,
      problems,
      descendantCompact: {
        threadId: grandchildId,
        turnId: descendantCompactTurnId,
        compactionsBefore: descendantCompactionsBefore,
        compactionsAfter: descendantCompactionsAfter,
      },
    };
  } catch (error) {
    const message = lifecycleErrorCategory(error);
    const failed: HierarchyScenarioResult = {
      status: message.includes("RATE_OR_VERIFICATION_LIMIT") ? "blocked" : "failed",
      threadId,
      turnId,
      finalText: "",
      checks: {},
      activities: activities(run, startedAt),
      agents: { root: threadId, child: "", grandchild: "" },
      agentTabs: { root: "", child: "", grandchild: "" },
      tabs: events(startedAt).filter(value => value.event === "browser.tab_created")
        .flatMap(value => value.detail?.tabId ? [String(value.detail.tabId)] : []),
      traces: events(startedAt).filter(value => value.event === "browser.tab_created")
        .flatMap(value => value.detail?.traceId ? [String(value.detail.traceId)] : []),
      problems: [{ check: "scenario_completed", message }],
      message,
    };
    saveRedactedLifecycleJson(join(artifactRoot, "failure.json"), failed);
    return failed;
  }
}
