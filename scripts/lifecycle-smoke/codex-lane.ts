import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  assert, auditPrompt, cutoff, detectRestriction, events, iso, LaneResult, repo, repoTests, reviewTaskPrompt,
  save, serviceBaseUrl, sleep, stageTimeline, steeringAuditPassed, steeringText, waitCreateBudget, waitForEvent,
  waitRootRequestBudget, waitSteeringPoint,
} from "./common";
import { activeTurnSmokeTimeoutMs, agentTextStreamDiagnostic, CodexRun, completed } from "./codex-app-server";
import { normalizeV2Activities } from "./codex-v2-activity";
import { runV2HierarchyScenario } from "./codex-v2-scenario";
import { hasLocalFileEvidence, skillContractEvidence } from "./skill-contract";
import { smokePath } from "./paths";
import { lifecycleErrorCategory, saveLifecycleContentSummary, saveRedactedLifecycleJson } from "./artifacts";
import { fetchWithTimeout } from "./run-guard";

export function selfTestCodexLaneBudget(): void {
  assert(
    activeTurnSmokeTimeoutMs > 30 * 60_000,
    "Codex long-task smoke budget must exceed the supported 30-minute active-turn window",
  );
  assert(
    retainedConversationWasReleased([
      {
        at: "2026-01-01T00:00:00.000Z",
        event: "runtime.daemon_stdout",
        detail: { line: "[chatgpt-web] released superseded retained conversation surfaces=1" },
      },
    ] as ReturnType<typeof events>, "source-tab"),
    "A successful conversation-key release response should prove retained source retirement",
  );
}

export function retainedConversationWasReleased(
  launcher: ReturnType<typeof events>,
  sourceTab: string,
): boolean {
  if (launcher.some(value => (
    value.event === "browser.tab_released" && value.detail?.tabId === sourceTab
  ))) return true;
  const authoritativeReleases = launcher.filter(value => (
    value.event === "runtime.daemon_stdout"
    && String(value.detail?.line ?? "").endsWith(
      "[chatgpt-web] released superseded retained conversation surfaces=1",
    )
  ));
  return authoritativeReleases.length === 1;
}

export function childTtlResumePrompt(childId: string): string {
  assert(childId, "Completed grandchild identity is required for TTL resume");
  return `你必須呼叫 send_input，且 target=${childId}，與這位已正常完成的同一位 grandchild 再互動，詢問它是否仍記得階層測試中的證據與摩擦；不要另派新的 subagent。收到回覆後，整理這段工作中的訊息追加、兩次上下文整理、交接、階層式 subagent 協作、中止與 TTL 續接，以及你觀察到的不足。`;
}

export async function runCodexLane(runRoot: string): Promise<LaneResult> {
  const laneRoot = join(runRoot, "codex"); mkdirSync(laneRoot, { recursive: true });
  const timelines: Record<string, any>[] = []; const checks: Record<string, boolean> = {}; const tabs = new Set<string>();
  const runs: CodexRun[] = []; let threadId = ""; let rootTab = ""; let childTab = ""; let childId = ""; let childAt = 0; let lastRootRequestAt = 0;
  let interruptedChildTab = "";
  try {
    await waitCreateBudget();
    const catalogBefore = Number((await (await fetchWithTimeout(`${serviceBaseUrl}/healthz`, 5_000, "Codex catalog preflight")).json()).successful_model_catalog_requests ?? 0);
    const run = new CodexRun(join(laneRoot, "app-server.jsonl")); runs.push(run); await run.initialize();
    const config = await run.request("config/read", { includeLayers: false });
    assert(config.config?.model_auto_compact_token_limit === 100_000, "Codex compact override is not 100000");
    await run.request("model/list", { includeHidden: true });
    const catalogDeadline = Date.now() + 30_000;
    let catalogReady = false;
    while (Date.now() < catalogDeadline) {
      const health = await (await fetchWithTimeout(`${serviceBaseUrl}/healthz`, 5_000, "Codex catalog readiness")).json();
      if (Number(health.successful_model_catalog_requests ?? 0) > catalogBefore) { catalogReady = true; break; }
      await sleep(250);
    }
    assert(catalogReady, "Codex app-server did not refresh the Web model catalog");
    await sleep(250);
    const models = await run.request("model/list", { includeHidden: true });
    const webModel = models.data?.find((model: any) => model.id === "chatgpt-web/extra-high");
    assert(webModel, "Codex Web model catalog did not load the Extra High route");
    const thread = await run.request("thread/start", { cwd: repo, model: "chatgpt-web/extra-high", ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
    threadId = String(thread.thread.id);
    const responseStateCompactionPath = smokePath(repoTests, "response-state-compaction.test.ts");
    const initialAt = Date.now();
    lastRootRequestAt = initialAt;
    const initial = await run.request("turn/start", { threadId, effort: "xhigh", input: [{ type: "text", text: `請依 OpenAI 官方文件說明 Responses API compaction continuation contract，再唯讀檢查 ${responseStateCompactionPath}，指出最直接覆蓋 compaction replacement boundary 的兩個測試。請提供官方連結與本機檔名、行號證據；不要派發 subagent、修改檔案或執行測試，也不要使用非 OpenAI 網站。` }] });
    const created = await waitForEvent(initialAt, "browser.tab_created", 180_000); rootTab = String(created.detail?.tabId); tabs.add(rootTab); const trace = String(created.detail?.traceId);
    const hadCommentary = await waitSteeringPoint(initialAt, trace);
    const steeringAt = Date.now();
    await run.request("turn/steer", { threadId, expectedTurnId: initial.turn.id, input: [{ type: "text", text: steeringText }] });
    await completed(run, initial.turn.id, activeTurnSmokeTimeoutMs);
    const initialDone = Date.now(); const initialText = run.messages(threadId).join("\n").replaceAll("\\_", "_");
    const rootEvents = (since: number) => events(since).filter(value => value.detail?.tabId === rootTab);
    for (const value of rootEvents(initialAt).filter(value => value.event === "browser.tab_created")) {
      rootTab = String(value.detail?.tabId); tabs.add(rootTab);
    }
    const initialTurnMessages = run.received.flatMap(message => message.method === "item/completed" && message.params?.turnId === initial.turn.id && message.params?.item?.type === "agentMessage" ? [String(message.params.item.text)] : []).join("\n").replaceAll("\\_", "_");
    checks.initial_tool_completed = run.received.some(message => message.method === "item/completed" && message.params?.turnId === initial.turn.id && ["commandExecution", "mcpToolCall"].includes(message.params?.item?.type));
    checks.initial_commentary_observed = hadCommentary;
    checks.initial_retained = rootEvents(initialAt).some(value => value.event === "browser.tab_retained" && value.detail?.tabId === rootTab);
    checks.steering_no_new_surface = !rootEvents(steeringAt).some(value => value.event === "browser.tab_created");
    const skillEvidence = skillContractEvidence(run.received, events(initialAt), initial.turn.id, trace);
    await save(join(laneRoot, "skill-contract.json"), skillEvidence);
    checks.initial_archive_transport = skillEvidence.archiveTransport;
    checks.initial_archive_complete = skillEvidence.archiveComplete;
    checks.skill_read_first = skillEvidence.firstWorkWasSkillRead;
    checks.skill_read_after_archive = skillEvidence.skillReadAfterArchive;
    checks.skill_read_complete = skillEvidence.skillReadComplete;
    checks.skill_official_citation = /https:\/\/(?:developers|platform|learn)\.openai\.com\//i.test(initialTurnMessages);
    checks.skill_local_evidence = hasLocalFileEvidence(
      run.received,
      initial.turn.id,
      responseStateCompactionPath,
      initialTurnMessages,
    );
    checks.no_unsubstantiated_skill_failure = !/(?:skill|skill\.md)[^\n]{0,120}(?:安全[^\n]{0,40}(?:阻擋|攔下)|無法讀取|unavailable|blocked|rejected)|(?:安全檢查|security check)[^\n]{0,120}(?:阻擋|攔下|blocked|rejected)/i.test(initialTurnMessages);
    assert(checks.initial_archive_transport, "Codex skill preflight did not use the Native2 context archive");
    assert(checks.initial_archive_complete, "Codex skill preflight did not complete the Native2 context archive");
    assert(checks.skill_read_first, "Codex did not read the selected Skill before other native work tools");
    assert(checks.skill_read_after_archive, "Codex attempted the selected Skill before the context archive completed");
    assert(checks.skill_read_complete, "Codex did not complete the selected SKILL.md read");
    assert(checks.skill_official_citation && checks.skill_local_evidence, "Codex skill preflight omitted official or local evidence");
    assert(checks.no_unsubstantiated_skill_failure, "Codex reported an unsupported Skill blocking cause");
    timelines.push(stageTimeline(initialAt, trace, { phase: "initial", request_sent: iso(initialAt), completed: iso(initialDone), ...run.firstClientTimes(initialAt) }));

    await waitRootRequestBudget(lastRootRequestAt);
    const auditAt = Date.now();
    lastRootRequestAt = auditAt;
    const audit = await run.request("turn/start", {
      threadId, effort: "xhigh", input: [{ type: "text", text: auditPrompt }],
    });
    await completed(run, audit.turn.id, activeTurnSmokeTimeoutMs);
    const auditDone = Date.now();
    const auditText = run.received.flatMap(message => message.method === "item/completed"
      && message.params?.turnId === audit.turn.id && message.params?.item?.type === "agentMessage"
      ? [String(message.params.item.text)] : []).join("\n").replaceAll("\\_", "_");
    saveLifecycleContentSummary(join(laneRoot, "steering-audit.json"), "steering_audit", auditText);
    const auditSurface = rootEvents(auditAt).findLast(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
    for (const value of rootEvents(auditAt).filter(value => value.event === "browser.tab_created")) {
      rootTab = String(value.detail?.tabId); tabs.add(rootTab);
    }
    timelines.push(stageTimeline(auditAt, String(auditSurface?.detail?.traceId ?? ""), {
      phase: "steering_audit", request_sent: iso(auditAt), completed: iso(auditDone), ...run.firstClientTimes(auditAt),
    }));

    await waitRootRequestBudget(lastRootRequestAt);
    const longAt = Date.now();
    const preAutoCompactRootTab = rootTab;
    let longToolCalls = 0;
    for (let round = 1; round <= 8 && run.compactions(threadId) === 0; round += 1) {
      if (round > 1) await waitRootRequestBudget(lastRootRequestAt);
      const taskAt = Date.now();
      lastRootRequestAt = taskAt;
      const task = await run.request("turn/start", { threadId, effort: "xhigh", input: [{ type: "text", text: round === 1 ? reviewTaskPrompt : `請繼續上一輪的唯讀檢查，自行從 ${repoTests} 選擇恰好兩個尚未檢查的測試檔案及其直接對應的 production 實作；完成這個有界範圍後立即總結，不要擴張到其他面向。不要重複已完成範圍、不要派發 subagent、不要修改檔案、執行測試或存取網路。` }] });
      await completed(run, task.turn.id, activeTurnSmokeTimeoutMs); const taskDone = Date.now();
      const taskText = run.received.flatMap(message => message.method === "item/completed" && message.params?.turnId === task.turn.id && message.params?.item?.type === "agentMessage" ? [String(message.params.item.text)] : []).join("\n").replaceAll("\\_", "_");
      longToolCalls += run.received.filter(message => message.method === "item/completed" && message.params?.turnId === task.turn.id && ["commandExecution", "mcpToolCall"].includes(message.params?.item?.type)).length;
      const surface = rootEvents(taskAt).find(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
      for (const value of rootEvents(taskAt).filter(value => value.event === "browser.tab_created")) { rootTab = String(value.detail?.tabId); tabs.add(rootTab); }
      timelines.push(stageTimeline(taskAt, String(surface?.detail?.traceId ?? ""), { phase: `long_task_${round}`, request_sent: iso(taskAt), completed: iso(taskDone), ...run.firstClientTimes(taskAt) }));
    }
    checks.long_task_used_tools = longToolCalls > 0;
    checks.root_ttl_reused = rootEvents(longAt).some(value => value.event === "browser.tab_reused");
    const autoCompactions = run.compactions(threadId);
    checks.auto_compact_observed = autoCompactions >= 1;
    checks.auto_compact_released_prior_root = retainedConversationWasReleased(
      events(longAt),
      preAutoCompactRootTab,
    );
    checks.steering_audit_exact_once = steeringAuditPassed(auditText);
    assert(checks.long_task_used_tools, "Codex long task ended without tool work");
    assert(checks.auto_compact_observed, "Codex did not observe an automatic compact");

    await waitCreateBudget();
    await waitRootRequestBudget(lastRootRequestAt);
    lastRootRequestAt = Date.now();
    childAt = Date.now();
    const hierarchyRoot = join(laneRoot, "v2-hierarchy"); mkdirSync(hierarchyRoot, { recursive: true });
    // The automatic compaction above installs a new canonical epoch, so the
    // hierarchy root must acquire a fresh surface before the two child levels.
    const hierarchy = await runV2HierarchyScenario(run, threadId, hierarchyRoot, { expectFreshRoot: false });
    const childText = hierarchy.finalText.replaceAll("\\_", "_");
    saveLifecycleContentSummary(join(laneRoot, "handoff.json"), "handoff", childText);
    saveLifecycleContentSummary(join(laneRoot, "steering-audit.json"), "steering_audit", auditText);
    saveLifecycleContentSummary(join(laneRoot, "child-friction.json"), "child_friction", childText);
    checks.handoff_seen = childText.includes("摩擦");
    interruptedChildTab = hierarchy.agentTabs.child;
    childId = hierarchy.agents.grandchild;
    rootTab = hierarchy.agentTabs.root || rootTab;
    childTab = hierarchy.agentTabs.grandchild;
    for (const tab of hierarchy.tabs) if (tab) tabs.add(tab);
    checks.child_completed = Boolean(hierarchy.agents.child && childId && interruptedChildTab
      && childTab && childText.trim() && hierarchy.status === "passed");
    checks.child_interacted = hierarchy.checks.root_interacted_child === true;
    checks.v2_hierarchy_completed = hierarchy.status === "passed";
    checks.v2_grandchild_completed = hierarchy.checks.grandchild_completed === true;
    checks.v2_child_interrupted = hierarchy.checks.child_interrupted_once === true;
    if (hierarchy.status !== "passed") {
      const detail = hierarchy.message ?? hierarchy.problems.map(problem => problem.check).join(", ");
      if (hierarchy.status === "blocked") throw new Error(`RATE_OR_VERIFICATION_LIMIT: ${detail}`);
      throw new Error(`Codex V2 hierarchy failed before manual compact: ${detail}`);
    }

    await waitRootRequestBudget(lastRootRequestAt);
    const preManualCompactRootTab = rootTab;
    const preManualCompactions = run.compactions(threadId);
    const compactAt = Date.now(); await run.request("thread/compact/start", { threadId });
    lastRootRequestAt = compactAt;
    const compact = await run.waitFor(message => message.method === "item/completed" && message.params?.threadId === threadId && message.params?.item?.type === "contextCompaction" && run.compactions(threadId) > preManualCompactions, activeTurnSmokeTimeoutMs, "manual compact");
    await run.waitFor(message => message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === compact.params?.turnId, 60_000, "manual compact turn completion");
    const postManualCompactions = run.compactions(threadId);
    checks.manual_compact_observed = postManualCompactions > preManualCompactions;
    await save(join(laneRoot, "compact-counts.json"), {
      automaticBeforeHierarchy: autoCompactions,
      beforeManual: preManualCompactions,
      afterManual: postManualCompactions,
    });
    checks.manual_compact_retained = rootEvents(compactAt).some(value => value.event === "browser.tab_reused" && value.detail?.tabId === rootTab) && !rootEvents(compactAt).some(value => value.event === "browser.tab_created");
    checks.manual_compact_released_prior_root = retainedConversationWasReleased(
      events(compactAt),
      preManualCompactRootTab,
    );
    saveRedactedLifecycleJson(join(laneRoot, "retained-release-debug.json"), {
      auto: {
        sourceTab: preAutoCompactRootTab,
        events: events(longAt).filter(value => value.event === "browser.tab_released"
          && value.detail?.tabId === preAutoCompactRootTab),
      },
      manual: {
        sourceTab: preManualCompactRootTab,
        events: events(compactAt).filter(value => value.event === "browser.tab_released"
          && value.detail?.tabId === preManualCompactRootTab),
      },
    });

    await waitCreateBudget();
    await waitRootRequestBudget(lastRootRequestAt);
    const finalAt = Date.now();
    lastRootRequestAt = finalAt;
    const final = await run.request("turn/start", { threadId, effort: "xhigh", input: [{ type: "text", text: childTtlResumePrompt(childId) }] });
    await completed(run, final.turn.id, activeTurnSmokeTimeoutMs); const finalDone = Date.now();
    const finalMessages = run.messages(threadId).join("\n").replaceAll("\\_", "_");
    saveLifecycleContentSummary(join(laneRoot, "final.json"), "final", finalMessages);
    const finalEvents = events(finalAt); for (const value of finalEvents.filter(value => value.event === "browser.tab_created")) if (value.detail?.tabId) tabs.add(String(value.detail.tabId));
    const resumedChildInteraction = normalizeV2Activities(run.received, finalAt)
      .find(activity => activity.kind === "interacted" && activity.agentThreadId === childId);
    const interruptedChildReleased = events(childAt).some(value => value.event === "browser.tab_released"
      && value.detail?.tabId === interruptedChildTab && value.detail?.status === "aborted");
    const compactedChildReleased = events(childAt).some(value => value.event === "browser.tab_released"
      && value.detail?.tabId === childTab && value.detail?.reason === "retained_conversation_superseded");
    const finalCreatedTabs = finalEvents.filter(value => value.event === "browser.tab_created");
    const childEpochCreates = resumedChildInteraction ? finalCreatedTabs.filter(value => (
      Date.parse(value.at) >= Date.parse(resumedChildInteraction.at)
    )) : [];
    checks.child_ttl_resumed_safely = Boolean(resumedChildInteraction) && interruptedChildReleased
      && compactedChildReleased && finalCreatedTabs.length === 2 && childEpochCreates.length === 1
      && childEpochCreates[0]?.detail?.tabId !== childTab;
    const finalTurnMessages = run.received.flatMap(message => message.method === "item/completed" && message.params?.turnId === final.turn.id && message.params?.item?.type === "agentMessage" ? [String(message.params.item.text)] : []).join("\n").replaceAll("\\_", "_");
    checks.final_completed = finalTurnMessages.trim().length > 0;
    checks.no_terminal_failures = !events(initialAt).some(value => /legacy compact|invalid, expired, or revoked|web error|tool replay/i.test(JSON.stringify(value)));
    const finalSurface = rootEvents(finalAt).find(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
    timelines.push(stageTimeline(finalAt, String(finalSurface?.detail?.traceId ?? ""), { phase: "post_manual_child_ttl", request_sent: iso(finalAt), completed: iso(finalDone), ...run.firstClientTimes(finalAt) }));
    detectRestriction(events(initialAt));
    checks.adapter_latency = timelines.every(value => value.adapter_to_cli_ms === null
      || Number(value.adapter_to_cli_ms) <= 2_000);
    checks.commentary_stability_bounded = timelines.every(value => value.web_commentary_stable_ms === null
      || Number(value.web_commentary_stable_ms) <= 10_000);
    const textStream = agentTextStreamDiagnostic(run.received, initialAt);
    await save(join(laneRoot, "agent-text-stream.json"), textStream);
    checks.agent_text_delta_observed = textStream.deltaCount > 0;
    checks.agent_text_no_prefix_replay = textStream.replays.length === 0;
    checks.agent_text_reconstruction_exact = textStream.reconstructionMismatches.length === 0;
    const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
    const result: LaneResult = { status, lane: "codex", threadId, checks, timelines, artifacts: { root: laneRoot, rootTab, childTab, childId } };
    await save(join(laneRoot, "result.json"), result); return result;
  } catch (error) {
    const message = lifecycleErrorCategory(error);
    const result: LaneResult = { status: message.includes("RATE_OR_VERIFICATION_LIMIT") ? "blocked" : "failed", lane: "codex", threadId, checks, timelines, artifacts: { root: laneRoot, rootTab, childTab, childId }, message };
    await save(join(laneRoot, "result.json"), result); return result;
  } finally {
    for (const run of runs) await run.close().catch(() => {});
    if (childAt && !childTab) {
      childTab = String(events(childAt).find(value => value.event === "browser.tab_created" && value.detail?.tabId !== rootTab)?.detail?.tabId ?? "");
      if (childTab) tabs.add(childTab);
    }
    for (const tab of tabs) await cutoff(tab).catch(() => {});
  }
}
