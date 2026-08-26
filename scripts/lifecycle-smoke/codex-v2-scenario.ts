import { join } from "node:path";
import { activeTurnSmokeTimeoutMs, CodexRun, completed, Rpc } from "./codex-app-server";
import { assert, detectRestriction, events, iso, repo, save } from "./common";
import { normalizeV2Activities, type V2Activity } from "./codex-v2-activity";

export const hierarchySentinel = "V2_HIERARCHY_SMOKE_DONE";

export const hierarchyPrompt = `請在唯讀、不修改檔案、不執行測試、不使用網路的條件下，驗證一次階層式 Multi-Agent 協作。工作範圍只限 ${repo}\\tests。

請先自行閱讀一個相關測試檔案，再派出恰好一位 child。請 child 先閱讀另一個相關測試檔案，至少讓相鄰的 Web 工作階段建立相隔 30 秒，再由 child 派出恰好一位 grandchild。Child 成功建立 grandchild 後，不要等待 grandchild；應立即完成自己的當前 turn，並在結果中回報 grandchild agent id 與已讀證據，讓 root 透過正常 wait 結果取得身分。Grandchild 要做一項短小的唯讀探查，提供可核對的檔案證據並回報實際摩擦。

Root 必須先等到 child 的完成結果明確回報已成功建立 grandchild 及其 agent id；在看到這項實際建立證據以前，不得對 child 或 grandchild 傳送訊息。取得身分後，再分別主動詢問兩者一次並取得各自回覆；不要重複傳送同一問題。對 child 的新訊息應要求它回覆後維持當前 turn 活動，等待 root 中止。取得兩層互動證據後，請主動中止仍在執行的 child。Grandchild 必須正常完成。最後確認沒有遺留仍在執行的 Agent，整理 root → child → grandchild 的身分、兩次互動、一次中止、grandchild 證據與每層摩擦。

請自行使用已提供的原生 Multi-Agent 工具完成整個流程，不要要求使用者介入。最後一行只輸出 ${hierarchySentinel}。`;

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

function traceIdForLauncherEvent(value: ReturnType<typeof events>[number]): string {
  const direct = String(value.detail?.traceId ?? "");
  if (direct) return direct;
  const line = String(value.detail?.line ?? "");
  return line.match(/browser turn ([A-Za-z0-9_-]+)/)?.[1]
    ?? line.match(/broker trace=([A-Za-z0-9_-]+)/)?.[1]
    ?? "";
}

export function activeBrowserTraceIds(launcher: ReturnType<typeof events>): Set<string> {
  const active = new Set<string>();
  for (const value of launcher) {
    const traceId = traceIdForLauncherEvent(value);
    if (!traceId) continue;
    if (value.event === "browser.turn_started") active.add(traceId);
    if (value.event === "browser.turn_ended") active.delete(traceId);
  }
  return active;
}

function excludeLauncherTraces(
  launcher: ReturnType<typeof events>,
  excludedTraces: ReadonlySet<string>,
): ReturnType<typeof events> {
  if (excludedTraces.size === 0) return launcher;
  return launcher.filter(value => {
    const traceId = traceIdForLauncherEvent(value);
    return !traceId || !excludedTraces.has(traceId);
  });
}

export function safeSurfaceRecoveryCount(
  launcher: ReturnType<typeof events>,
  excludedTraces: ReadonlySet<string> = new Set(),
): number | undefined {
  const ownedLauncher = excludeLauncherTraces(launcher, excludedTraces);
  const eligible = ownedLauncher.filter(value => /surface recovery eligible=true/.test(String(value.detail?.line ?? "")));
  if (eligible.length > 1) return undefined;
  for (const recovery of eligible) {
    const line = String(recovery.detail?.line ?? "");
    const traceId = line.match(/browser turn ([A-Za-z0-9_-]+)/)?.[1];
    if (!traceId
      || !/reason=eligible/.test(line)
      || !/finalChars=0/.test(line)
      || !/canonicalComplete=true/.test(line)
      || !/unresolvedSuperseded=0/.test(line)) return undefined;
    const created = ownedLauncher.find(value => value.event === "browser.tab_created"
      && value.detail?.traceId === traceId
      && Date.parse(value.at) >= Date.parse(recovery.at));
    const released = ownedLauncher.findLast(value => value.event === "browser.tab_released"
      && value.detail?.traceId === traceId
      && (value.detail?.status === "error" || value.detail?.status === "aborted")
      && Date.parse(value.at) <= Date.parse(created?.at ?? ""));
    const completed = ownedLauncher.find(value => value.event === "browser.tab_completed"
      && value.detail?.traceId === traceId
      && Date.parse(value.at) >= Date.parse(created?.at ?? ""));
    const rebuild = ownedLauncher.find(value => String(value.detail?.line ?? "")
      .includes(`browser turn ${traceId} rebuilding tool surface from canonical state`));
    if (!released || !created || !completed || !rebuild) return undefined;
  }
  return eligible.length;
}

export function latestSurfaceTabForTrace(
  launcher: ReturnType<typeof events>,
  traceId: string,
): string {
  return String(launcher.findLast(value => (
    (value.event === "browser.tab_created" || value.event === "browser.tab_reused")
    && value.detail?.traceId === traceId && value.detail?.tabId
  ))?.detail?.tabId ?? "");
}

export function classifyHierarchySurfaces(
  launcher: ReturnType<typeof events>,
  firstSpawnAt: number,
  expectFreshRoot: boolean | undefined,
  safeRecoveries: number | undefined,
  excludedTraces: ReadonlySet<string> = new Set(),
) {
  const ownedLauncher = excludeLauncherTraces(launcher, excludedTraces);
  const surfaces = ownedLauncher.filter(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
  const creates = surfaces.filter(value => value.event === "browser.tab_created");
  const rootSurfaces = surfaces.filter(value => Date.parse(value.at) < firstSpawnAt);
  const rootCreates = rootSurfaces.filter(value => value.event === "browser.tab_created");
  const rootTrace = String(rootSurfaces.findLast(value => value.detail?.traceId)?.detail?.traceId ?? "");
  const descendantCreates = creates.filter(value => (
    Date.parse(value.at) >= firstSpawnAt
    && String(value.detail?.traceId ?? "") !== rootTrace
  ));
  const descendantTabs = [...new Set(descendantCreates.flatMap(value => (
    value.detail?.tabId ? [String(value.detail.tabId)] : []
  )))];
  const retainedRootReplacement = expectFreshRoot === false ? rootCreates.length : 0;
  const expectedCreates = (expectFreshRoot === false ? 2 : 3)
    + (safeRecoveries ?? 0)
    + retainedRootReplacement;
  const rootAcquisitionValid = expectFreshRoot === false
    ? rootSurfaces.some(value => value.event === "browser.tab_reused") && rootCreates.length <= 1
    : rootCreates.length >= 1;
  return {
    surfaces,
    creates,
    rootTrace,
    descendantTabs,
    expected: safeRecoveries !== undefined
      && rootAcquisitionValid
      && descendantTabs.length === 2
      && creates.length === expectedCreates,
  };
}

export function selfTestHierarchySurfaceClassification() {
  const launcher = [
    { at: "2026-01-01T00:00:00.000Z", event: "browser.tab_reused", detail: { tabId: "old-root", traceId: "old-root-trace" } },
    { at: "2026-01-01T00:00:01.000Z", event: "browser.tab_created", detail: { tabId: "new-root", traceId: "new-root-trace" } },
    { at: "2026-01-01T00:00:03.000Z", event: "browser.tab_created", detail: { tabId: "child", traceId: "child-trace" } },
    { at: "2026-01-01T00:00:05.000Z", event: "browser.tab_created", detail: { tabId: "grandchild", traceId: "grandchild-trace" } },
    { at: "2026-01-01T00:00:06.000Z", event: "browser.tab_created", detail: { tabId: "recovered-root", traceId: "new-root-trace" } },
  ] as ReturnType<typeof events>;
  const classified = classifyHierarchySurfaces(
    launcher,
    Date.parse("2026-01-01T00:00:02.000Z"),
    false,
    1,
  );
  assert(classified.expected, "Retained root replacement should not count as a third descendant");
  assert(classified.rootTrace === "new-root-trace", "Final root trace should follow the replacement surface");
  assert(classified.descendantTabs.join(",") === "child,grandchild", "Hierarchy descendants should exclude root surfaces");

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
    const rootInteractions = activity.filter(value => value.kind === "interacted" && value.parentThreadId === threadId);
    const interrupts = activity.filter(value => value.kind === "interrupted");
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
    await Bun.write(join(artifactRoot, "final.md"), finalText);
    await save(join(artifactRoot, "agent-activity.json"), activity);
    await save(join(artifactRoot, "tool-ledger.json"), ledger);
    await save(join(artifactRoot, "thread-states.json"), { child: childState, grandchild: grandchildState });
    await save(join(artifactRoot, "timeline.json"), { startedAt: iso(startedAt), completedAt: iso(completedAt), creates });
    await save(join(artifactRoot, "recovery-projection.json"), diagnostics);
    await save(join(artifactRoot, "descendant-compact.json"), {
      threadId: grandchildId,
      turnId: descendantCompactTurnId,
      compactionsBefore: descendantCompactionsBefore,
      compactionsAfter: descendantCompactionsAfter,
      launcher: descendantCompactEvents,
    });
    await Bun.write(join(artifactRoot, "launcher.jsonl"), `${launcher.map(value => JSON.stringify(value)).join("\n")}\n`);
    await Bun.write(join(artifactRoot, "problems.jsonl"), `${problems.map(value => JSON.stringify(value)).join("\n")}${problems.length ? "\n" : ""}`);
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
    const message = error instanceof Error ? error.message : String(error);
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
    await save(join(artifactRoot, "failure.json"), failed);
    return failed;
  }
}
