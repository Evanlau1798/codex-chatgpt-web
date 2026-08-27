import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../../src/stall-timeout";
import { buildClaudeSmokeSettings, selfTestClaudeSmokeSettings } from "./claude-config";
import {
  CLAUDE_RESULT_ABSOLUTE_TIMEOUT_MS,
  ClaudeResultWatchdog,
  waitForClaudeCommandExit,
} from "./claude-watchdog";
import { manualCompactPreservedRetainedRoot, selfTestManualCompactRetainedRoot } from "./retained-check";
import {
  assert, auditPrompt, claudeExe, cleanupLifecycleResources, cutoff, detectRestriction, events, iso, LaneResult, repo, repoTests, reviewTaskPrompt,
  save, sleep, stageTimeline, steeringAuditPassed, steeringText, submitClaudeSteering, waitCreateBudget, waitForEvent,
  waitRootRequestBudget, waitSteeringPoint,
} from "./common";
import { findClaudeTranscript, smokePath } from "./paths";
import {
  LifecycleArtifactEncoder,
  LifecycleMemoryBudget,
  appendLifecycleArtifact,
  lifecycleErrorCategory,
  readBoundedLifecycleProcess,
  saveLifecycleContentSummary,
  summarizeClaudeRecord,
  summarizeStreamChunk,
} from "./artifacts";
type RecordValue = Record<string, any>;
export const CLAUDE_INITIAL_RESULT_TIMEOUT_MS = DEFAULT_STALL_TIMEOUT_SEC * 3 * 1_000 + 60_000;
function sentMessageTo(records: RecordValue[], childId: string): boolean {
  return records.some(record => record.type === "assistant"
    && record.message?.content?.some?.((block: RecordValue) => block.type === "tool_use"
      && block.name === "SendMessage"
      && [block.input?.to, block.input?.recipient].includes(childId)));
}

export function selfTestClaudeLaneBudget(): void {
  const required = DEFAULT_STALL_TIMEOUT_SEC * 3 * 1_000 + 60_000;
  assert(
    CLAUDE_INITIAL_RESULT_TIMEOUT_MS >= required,
    "Claude initial result timeout must let one hard recovery reach its own terminal stall boundary",
  );
  assert(sentMessageTo([{ type: "assistant", message: { content: [{
    type: "tool_use", name: "SendMessage", input: { to: "child" },
  }] } }], "child"), "Claude child interaction identity was not recognized");
  assert(!sentMessageTo([{ type: "assistant", message: { content: [{
    type: "tool_use", name: "SendMessage", input: { to: "other" },
  }] } }], "child"), "Claude child interaction matched the wrong recipient");
  assert(CLAUDE_RESULT_ABSOLUTE_TIMEOUT_MS > 30 * 60_000,
    "Claude absolute result ceiling must cover the supported thirty-minute child turn");
  selfTestClaudeSmokeSettings(loadConfig());
  selfTestManualCompactRetainedRoot();
}

export class ClaudeRun {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly records: RecordValue[] = [];
  readonly receivedAt: { at: string; value: RecordValue }[] = [];
  private results = 0;
  private buffer = "";
  private waiters = new Set<() => void>();
  private outputEncoder = new LifecycleArtifactEncoder();
  private stderrEncoder = new LifecycleArtifactEncoder();
  private memoryBudget = new LifecycleMemoryBudget();
  private readFailure?: Error;
  private outputTask: Promise<void>;
  private errorTask: Promise<void>;

  constructor(private output: string, args: string[], configDir: string, controlToken: string) {
    this.process = Bun.spawn({
      cmd: [claudeExe, ...args], cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000", CODEX_CHATGPT_WEB_CONTROL_TOKEN: controlToken },
    });
    this.outputTask = this.readOutput();
    this.errorTask = this.readErrors().catch(error => this.failRead(error));
  }

  private async readOutput() {
    try { await this.consumeOutput(); }
    catch (error) { this.failRead(error); }
  }

  private failRead(error: unknown) {
    if (this.readFailure) return;
    this.readFailure = error instanceof Error ? error : new Error(String(error));
    this.process.kill();
    for (const wake of this.waiters) wake();
  }

  private async consumeOutput() {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      const lines: string[] = [];
      for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (line) lines.push(line);
      }
      for (const line of lines) this.memoryBudget.retain(line, "Claude protocol");
      this.memoryBudget.assertLine(this.buffer, "Claude protocol");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const summary = this.outputEncoder.encode(summarizeClaudeRecord(parsed, iso()));
          if (summary) appendLifecycleArtifact(this.output, summary);
          this.records.push(parsed);
          this.receivedAt.push({ at: iso(), value: parsed });
          if (parsed.type === "result") this.results++;
          for (const wake of this.waiters) wake();
        } catch {
          const summary = this.outputEncoder.encode(summarizeStreamChunk("stdout", iso(), line.length));
          if (summary) appendLifecycleArtifact(this.output, summary);
        }
      }
    }
  }

  private async readErrors() {
    const path = this.output.replace(/\.jsonl$/, ".stderr.log");
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chars = decoder.decode(value, { stream: true }).length;
      const summary = this.stderrEncoder.encode(summarizeStreamChunk("stderr", iso(), chars));
      if (summary) appendLifecycleArtifact(path, summary);
    }
  }

  async send(sessionId: string, text: string) {
    if (this.readFailure) throw this.readFailure;
    this.process.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId })}\n`);
    await this.process.stdin.flush();
  }

  async waitResult(number: number, timeoutMs: number) {
    const watchdog = new ClaudeResultWatchdog(Date.now(), timeoutMs);
    let observedRecords = this.records.length;
    while (this.results < number && !watchdog.expired(Date.now())) {
      if (this.readFailure) throw this.readFailure;
      detectRestriction(events(Date.now() - 60_000));
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, 500);
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
      });
      if (this.records.length > observedRecords) {
        watchdog.observe(Date.now(), this.records.slice(observedRecords));
        observedRecords = this.records.length;
      }
    }
    if (this.readFailure) throw this.readFailure;
    assert(this.results >= number,
      `Claude result ${number} timed out: ${watchdog.expired(Date.now()) ?? "unknown"}`);
    const result = this.records.filter(record => record.type === "result")[number - 1];
    assert(result?.is_error !== true && result?.terminal_reason !== "api_error", `Claude result ${number} failed: ${result?.result ?? "unknown"}`);
    return result;
  }

  async waitFor(predicate: (record: RecordValue) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.readFailure) throw this.readFailure;
      const record = this.records.findLast(predicate);
      if (record) return record;
      detectRestriction(events(Date.now() - 60_000));
      await sleep(500);
    }
    throw new Error("Claude event timed out");
  }

  firstClientTimes(after: number) {
    const stream = this.receivedAt.filter(item => Date.parse(item.at) >= after && item.value.type === "stream_event");
    const delta = (type: string) => stream.find(item => item.value.event?.type === "content_block_delta" && item.value.event?.delta?.type === type)?.at ?? null;
    return { client_first_reasoning: delta("thinking_delta"), client_first_text: delta("text_delta") };
  }

  assistantTextSince(recordIndex: number) {
    return this.records.slice(recordIndex).flatMap(record => (
      record.type === "assistant" && Array.isArray(record.message?.content)
        ? record.message.content.flatMap((block: RecordValue) => block.type === "text" ? [String(block.text ?? "")] : [])
        : []
    )).join("\n");
  }

  rawText() { return this.records.map(record => JSON.stringify(record)).join("\n"); }
  async close() {
    try { this.process.stdin.end(); } catch (error) { if (!this.readFailure) throw error; }
    const code = await Promise.race([this.process.exited, sleep(15_000).then(() => null)]);
    if (code === null) {
      this.process.kill(9);
      await Promise.race([this.process.exited, sleep(5_000)]);
    }
    await Promise.all([this.outputTask, this.errorTask]);
    if (this.readFailure) throw this.readFailure;
  }
}

const args = (sessionId: string, resume: boolean, tools: string[], streamInput = true) => [
  "-p", resume ? "--resume" : "--session-id", sessionId,
  "--model", "claude-chatgpt-web-extra-high", "--effort", "xhigh",
  "--autocompact", "100k",
  ...(streamInput ? ["--input-format", "stream-json"] : []),
  "--output-format", "stream-json", "--include-partial-messages",
  "--include-hook-events", "--forward-subagent-text", "--verbose", "--permission-mode", "bypassPermissions",
  ...(tools.length > 0 ? ["--tools", tools.join(",")] : []),
];

async function runClaudeCommand(output: string, configDir: string, controlToken: string, sessionId: string, command: string) {
  const child = Bun.spawn({
    cmd: [claudeExe, ...args(sessionId, true, [], false), command], cwd: repo,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000", CODEX_CHATGPT_WEB_CONTROL_TOKEN: controlToken }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await readBoundedLifecycleProcess(
    child, waitForClaudeCommandExit(child), 8 * 1024 * 1024, "Claude command",
  );
  const outputEncoder = new LifecycleArtifactEncoder();
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let summary;
    try { summary = summarizeClaudeRecord(JSON.parse(line), iso()); }
    catch { summary = summarizeStreamChunk("stdout", iso(), line.length); }
    const encoded = outputEncoder.encode(summary);
    if (encoded) appendLifecycleArtifact(output, encoded);
  }
  if (stderr) {
    const encoded = new LifecycleArtifactEncoder().encode(summarizeStreamChunk("stderr", iso(), stderr.length));
    if (encoded) appendLifecycleArtifact(output.replace(/\.jsonl$/, ".stderr.log"), encoded);
  }
  assert(code === 0, `Claude ${command} failed with exit code ${code}`);
}

export async function runClaudeLane(runRoot: string): Promise<LaneResult> {
  const laneRoot = join(runRoot, "claude");
  mkdirSync(laneRoot, { recursive: true });
  const configDir = join(laneRoot, "config");
  mkdirSync(configDir, { recursive: true });
  const runtimeConfig = loadConfig();
  writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(buildClaudeSmokeSettings(runtimeConfig), null, 2)}\n`, "utf8");
  writeFileSync(join(configDir, ".claude.json"), '{"autoCompactEnabled":true}', "utf8");
  const sessionId = crypto.randomUUID();
  const timelines: Record<string, any>[] = [];
  const checks: Record<string, boolean> = {};
  const tabs = new Set<string>();
  const runs: ClaudeRun[] = [];
  let rootTab = "";
  let childTab = "";
  let childId = "";
  let lastRootRequestAt = 0;
  let rootTtlReused = false;
  try {
    await waitCreateBudget();
    const initialAt = Date.now();
    lastRootRequestAt = initialAt;
    const initial = new ClaudeRun(join(laneRoot, "initial.jsonl"), args(sessionId, false, []), configDir, runtimeConfig.controlToken);
    runs.push(initial);
    await initial.send(sessionId, `Respond only in English. Read ${smokePath(repoTests, "prompt-caret.test.ts")} and ${smokePath(repoTests, "retained-compaction-handoff.test.ts")}. Compare how they protect prompt submission and retained compaction, then identify one interaction risk worth deeper follow-up. Limit the inspection to those two files. Do not modify files, run tests, or access the network.`);
    const created = await waitForEvent(initialAt, "browser.tab_created", 180_000);
    rootTab = String(created.detail?.tabId); tabs.add(rootTab);
    let rootTrace = String(created.detail?.traceId);
    const hadCommentary = await waitSteeringPoint(initialAt, rootTrace, CLAUDE_INITIAL_RESULT_TIMEOUT_MS);
    const steeringAt = Date.now();
    await submitClaudeSteering(sessionId, steeringText, configDir);
    const initialResult = await initial.waitResult(1, CLAUDE_INITIAL_RESULT_TIMEOUT_MS);
    const initialDone = Date.now();
    await initial.close();
    const rootEvents = (since: number) => events(since).filter(value => value.detail?.traceId === rootTrace);
    for (const value of rootEvents(initialAt).filter(value => value.event === "browser.tab_created")) {
      rootTab = String(value.detail?.tabId); tabs.add(rootTab);
    }
    const initialText = initial.rawText().replaceAll("\\_", "_");
    checks.initial_tool_completed = initial.records.some(record => record.type === "assistant" && record.message?.content?.some?.((block: RecordValue) => block.type === "tool_use"))
      && initial.records.some(record => record.type === "user" && record.message?.content?.some?.((block: RecordValue) => block.type === "tool_result"));
    checks.initial_commentary_observed = hadCommentary;
    const steeringDeliveries = events(steeringAt).filter(value => {
      const line = JSON.stringify(value);
      return line.includes("delivered additive Claude steering prompts=1")
        || line.includes("continued additive Claude steering in the existing Web conversation");
    });
    checks.steering_hook_once = steeringDeliveries.length === 1;
    checks.steering_no_new_surface = !rootEvents(steeringAt).some(value => value.event === "browser.tab_created");
    checks.initial_retained = rootEvents(initialAt).some(value => value.event === "browser.tab_retained" && value.detail?.tabId === rootTab);
    timelines.push(stageTimeline(initialAt, rootTrace, { phase: "initial", request_sent: iso(initialAt), completed: iso(initialDone), ...initial.firstClientTimes(initialAt) }));
    assert(initialResult.subtype === "success", "Claude initial turn failed");

    await waitRootRequestBudget(lastRootRequestAt);
    const auditAt = Date.now();
    lastRootRequestAt = auditAt;
    const audit = new ClaudeRun(join(laneRoot, "steering-audit.jsonl"), args(sessionId, true, []), configDir, runtimeConfig.controlToken);
    runs.push(audit);
    await audit.send(sessionId, auditPrompt);
    const auditResult = await audit.waitResult(1, CLAUDE_INITIAL_RESULT_TIMEOUT_MS);
    const auditDone = Date.now();
    const auditText = (audit.assistantTextSince(0) || String(auditResult.result ?? "")).replaceAll("\\_", "_");
    await audit.close();
    saveLifecycleContentSummary(join(laneRoot, "steering-audit.json"), "steering_audit", auditText);
    const auditEvents = events(auditAt);
    const auditSurface = auditEvents.findLast(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
    for (const value of auditEvents.filter(value => value.event === "browser.tab_created")) {
      rootTab = String(value.detail?.tabId); tabs.add(rootTab);
    }
    if (auditSurface?.detail?.traceId) rootTrace = String(auditSurface.detail.traceId);
    timelines.push(stageTimeline(auditAt, String(auditSurface?.detail?.traceId ?? ""), {
      phase: "steering_audit", request_sent: iso(auditAt), completed: iso(auditDone), ...audit.firstClientTimes(auditAt),
    }));
    assert(auditResult.subtype === "success", "Claude steering audit turn failed");

    await waitRootRequestBudget(lastRootRequestAt);
    const longAt = Date.now();
    let longText = "";
    let longToolCalls = 0;
    let autoCompactions = claudeCompactions(configDir, sessionId, "auto");
    const preAutoCompactRootTab = rootTab;
    const task = new ClaudeRun(join(laneRoot, "long-task.jsonl"), args(sessionId, true, []), configDir, runtimeConfig.controlToken);
    runs.push(task);
    for (let round = 1; round <= 8 && autoCompactions === 0; round += 1) {
      if (round > 1) await waitRootRequestBudget(lastRootRequestAt);
      const roundRecordStart = task.records.length;
      const taskAt = Date.now();
      lastRootRequestAt = taskAt;
      await task.send(sessionId, round === 1 ? reviewTaskPrompt : `Respond only in English. This is read-only code review continuation round ${round}. First list the scope left uninspected by the previous round, then select exactly five new files from ${repoTests} or their directly corresponding production implementations for in-depth reading. Do not repeat completed scope; summarize immediately after five files. If the runtime naturally compacts during this round, continue the same task from the handoff. Start the response with ROUND_${round}_START and end it with ROUND_${round}_DONE. Do not dispatch a subagent, modify files, run tests, or access the network.`);
      const taskResult = await task.waitResult(round, 20 * 60_000);
      const taskDone = Date.now();
      const taskText = String(taskResult.result ?? "").replaceAll("\\_", "_");
      const assistantText = task.assistantTextSince(roundRecordStart).replaceAll("\\_", "_") || taskText;
      longText += `${assistantText}\n`;
      longToolCalls += task.records.filter(record => record.type === "assistant" && record.message?.content?.some?.((block: RecordValue) => block.type === "tool_use")).length;
      autoCompactions = claudeCompactions(configDir, sessionId, "auto");
      const taskEvents = events(taskAt);
      const surface = taskEvents.findLast(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
      rootTtlReused ||= taskEvents.some(value => value.event === "browser.tab_reused" && value.detail?.tabId === rootTab);
      for (const value of taskEvents.filter(value => value.event === "browser.tab_created")) { rootTab = String(value.detail?.tabId); tabs.add(rootTab); }
      if (surface?.detail?.traceId) rootTrace = String(surface.detail.traceId);
      timelines.push(stageTimeline(taskAt, String(surface?.detail?.traceId ?? ""), { phase: `long_task_${round}`, request_sent: iso(taskAt), completed: iso(taskDone), ...task.firstClientTimes(taskAt) }));
    }
    await task.close();
    checks.long_task_used_tools = longToolCalls > 0;
    checks.root_ttl_reused = rootTtlReused;
    checks.auto_compact_observed = autoCompactions >= 1;
    checks.steering_audit_exact_once = steeringAuditPassed(auditText);
    assert(checks.long_task_used_tools, "Claude long task ended without tool work");
    assert(checks.auto_compact_observed, "Claude did not observe an automatic compact");

    await waitCreateBudget();
    await waitRootRequestBudget(lastRootRequestAt);
    const handoffAt = Date.now();
    lastRootRequestAt = handoffAt;
    const childAt = handoffAt;
    const child = new ClaudeRun(join(laneRoot, "post-compact-child.jsonl"), args(sessionId, true, []), configDir, runtimeConfig.controlToken);
    runs.push(child);
    await child.send(sessionId, `Respond only in English. Briefly summarize completed progress and actual friction from the compaction handoff, then dispatch one subagent to read ${smokePath(repoTests, "prompt-caret.test.ts")} read-only. Ask it to report its observed cwd, the number of test() declarations, the first test name, and process friction. While it is still running, proactively send one follow-up request to that same subagent asking for the final test name; integrate the result only after receiving its reply. This probe needs no skill, so do not load one. Do not modify files, run tests, or access the network.`);
    const childResult = await child.waitResult(1, 30 * 60_000);
    const taskLifecycle = child.records.find(record => record.type === "system"
      && ["task_started", "task_progress", "task_notification"].includes(String(record.subtype))
      && (record.task_id || record.agent_id));
    childId = String(taskLifecycle?.task_id ?? taskLifecycle?.agent_id ?? "");
    assert(childId, "Claude child did not publish a task lifecycle identity");
    const childNotification = await child.waitFor(record => record.type === "system" && record.subtype === "task_notification"
      && record.task_id === childId && (record.status === "completed" || record.status === "failed"), 20 * 60_000);
    assert(childNotification.status === "completed", `Claude child failed: ${childNotification.summary ?? "unknown error"}`);
    await child.close();
    const childText = child.rawText().replaceAll("\\_", "_"); longText += childText;
    saveLifecycleContentSummary(join(laneRoot, "handoff.json"), "handoff", childText);
    saveLifecycleContentSummary(join(laneRoot, "steering-audit.json"), "steering_audit", auditText);
    saveLifecycleContentSummary(join(laneRoot, "child-friction.json"), "child_friction", childText);
    checks.handoff_seen = childText.toLowerCase().includes("friction");
    const childEvents = events(childAt);
    const acquisitions = childEvents.filter(value => (
      value.event === "browser.tab_created" || value.event === "browser.tab_reused"
    ) && value.detail?.traceId && value.detail?.tabId);
    const rootAcquisition = acquisitions[0];
    if (rootAcquisition) {
      rootTrace = String(rootAcquisition.detail!.traceId);
      rootTab = String(acquisitions.findLast(value => value.detail?.traceId === rootTrace)!.detail!.tabId);
    }
    const childTraces = [...new Set(acquisitions.flatMap(value => (
      value.detail?.traceId !== rootTrace ? [String(value.detail!.traceId)] : []
    )))];
    assert(childTraces.length === 1, `Claude expected one child Web trace, observed ${childTraces.length}`);
    childTab = String(acquisitions.findLast(value => value.detail?.traceId === childTraces[0])?.detail?.tabId ?? "");
    for (const value of childEvents.filter(value => value.event === "browser.tab_created")) {
      if (value.detail?.tabId) tabs.add(String(value.detail.tabId));
    }
    checks.auto_compact_rotated_root = rootTab !== preAutoCompactRootTab
      && events(longAt).some(value => value.event === "browser.tab_created" && value.detail?.tabId === rootTab);
    checks.child_completed = Boolean(childId && childTab && childResult?.subtype === "success");
    const childCompletionText = String(childNotification.summary ?? "");
    saveLifecycleContentSummary(join(laneRoot, "child-first-completion.json"), "child_completion", childCompletionText);
    checks.child_interacted = sentMessageTo(child.records, childId)
      && childCompletionText.includes("rejects a caret that Lexical moved outside the active composer");
    autoCompactions = claudeCompactions(configDir, sessionId, "auto");

    await waitRootRequestBudget(lastRootRequestAt);
    const compactAt = Date.now();
    lastRootRequestAt = compactAt;
    const preManualCompactRootTab = rootTab;
    const preManualCompactions = claudeCompactions(configDir, sessionId, "manual");
    await runClaudeCommand(join(laneRoot, "manual-compact.jsonl"), configDir, runtimeConfig.controlToken, sessionId, "/compact");
    const postManualCompactions = claudeCompactions(configDir, sessionId, "manual");
    checks.manual_compact_observed = postManualCompactions > preManualCompactions;
    await save(join(laneRoot, "compact-counts.json"), {
      automaticBeforeManual: autoCompactions,
      beforeManual: preManualCompactions,
      afterManual: postManualCompactions,
    });
    const compactEvents = events(compactAt);
    const compactRootEvents = rootEvents(compactAt);
    const compactReplacement = compactRootEvents.findLast(value => value.event === "browser.tab_created");
    const compactRecovery = compactEvents.some(value => {
      const line = JSON.stringify(value);
      return line.includes(rootTrace) && line.includes("surface recovery eligible=true");
    });
    checks.manual_compact_retained = manualCompactPreservedRetainedRoot(
      rootEvents(initialAt), compactRootEvents, rootTab,
    );
    checks.manual_compact_safe_recovery = !compactReplacement || compactRecovery;
    if (compactReplacement?.detail?.tabId) {
      rootTab = String(compactReplacement.detail.tabId);
      tabs.add(rootTab);
    }
    assert(checks.manual_compact_observed, "Claude native /compact boundary missing");

    await waitCreateBudget();
    await waitRootRequestBudget(lastRootRequestAt);
    const finalAt = Date.now();
    lastRootRequestAt = finalAt;
    const final = new ClaudeRun(join(laneRoot, "final.jsonl"), args(sessionId, true, []), configDir, runtimeConfig.controlToken);
    runs.push(final);
    await final.send(sessionId, `Respond only in English. Resume the existing subagent with agent ID ${childId}; do not dispatch a new subagent. Ask whether it remembers its previous tests-directory probe and result, and whether this resume introduced friction or context loss. Do not ask it to execute tools again. After receiving its reply, summarize steering, both compactions, handoff, the initial and resumed subagent interactions, and any observed gaps.`);
    const resumedChild = await final.waitFor(record => record.type === "system"
      && ["task_started", "task_progress", "task_notification"].includes(String(record.subtype))
      && (record.task_id || record.agent_id), 20 * 60_000);
    const resumedChildId = String(resumedChild.task_id ?? resumedChild.agent_id ?? "");
    assert(resumedChildId === childId, `Claude resumed the wrong child: ${resumedChildId}`);
    const resumedNotification = await final.waitFor(record => record.type === "system" && record.subtype === "task_notification"
      && record.task_id === resumedChildId && (record.status === "completed" || record.status === "failed"), 20 * 60_000);
    assert(resumedNotification.status === "completed", `Claude resumed child failed: ${resumedNotification.summary ?? "unknown error"}`);
    const finalResult = await final.waitResult(1, 30 * 60_000);
    const finalDone = Date.now();
    await final.close();
    const finalText = final.rawText().replaceAll("\\_", "_");
    saveLifecycleContentSummary(join(laneRoot, "final.json"), "final", String(finalResult.result ?? ""));
    const finalEvents = events(finalAt);
    const postManualRoot = finalEvents.find(value => value.event === "browser.tab_created"
      && value.detail?.tabId !== childTab);
    checks.manual_compact_rotated_root = Boolean(postManualRoot?.detail?.tabId
      && postManualRoot.detail.tabId !== preManualCompactRootTab);
    if (postManualRoot?.detail?.tabId) {
      rootTab = String(postManualRoot.detail.tabId);
      rootTrace = String(postManualRoot.detail.traceId ?? rootTrace);
    }
    for (const value of finalEvents.filter(value => value.event === "browser.tab_created")) {
      if (value.detail?.tabId) tabs.add(String(value.detail.tabId));
    }
    checks.child_ttl_reused = finalEvents.some(value => value.event === "browser.tab_reused" && value.detail?.tabId === childTab);
    checks.final_completed = String(finalResult.result ?? "").trim().length > 0;
    checks.no_terminal_failures = !events(initialAt).some(value => /legacy compact|invalid, expired, or revoked|web error|tool replay/i.test(JSON.stringify(value)));
    const finalSurface = postManualRoot ?? rootEvents(finalAt).find(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
    timelines.push(stageTimeline(finalAt, String(finalSurface?.detail?.traceId ?? ""), { phase: "post_manual_child_ttl", request_sent: iso(finalAt), completed: iso(finalDone), ...final.firstClientTimes(finalAt) }));
    assert(finalResult.subtype === "success", "Claude final turn failed");

    checks.latency = timelines.every(value => (value.adapter_to_cli_ms === null || Number(value.adapter_to_cli_ms) <= 2_000)
      && (value.web_commentary_to_cli_ms === null || Number(value.web_commentary_to_cli_ms) <= 5_000));
    const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
    const result: LaneResult = { status, lane: "claude", sessionId, checks, timelines, artifacts: { root: laneRoot, childId, rootTab, childTab } };
    await save(join(laneRoot, "result.json"), result);
    return result;
  } catch (error) {
    const message = lifecycleErrorCategory(error);
    const result: LaneResult = { status: message.includes("RATE_OR_VERIFICATION_LIMIT") ? "blocked" : "failed", lane: "claude", sessionId, checks, timelines, artifacts: { root: laneRoot, childId, rootTab, childTab }, message };
    await save(join(laneRoot, "result.json"), result);
    return result;
  } finally {
    try {
      await cleanupLifecycleResources(runs.filter(run => !run.process.killed).map(run => () => run.close()),
        [...tabs].map(tab => () => cutoff(tab)));
    } catch (error) {
      const message = lifecycleErrorCategory(error);
      await save(join(laneRoot, "result.json"), { status: "failed", lane: "claude", sessionId, checks, timelines, artifacts: { root: laneRoot, childId, rootTab, childTab }, message } satisfies LaneResult);
      throw error;
    }
  }
}

function claudeCompactions(configDir: string, sessionId: string, trigger: "auto" | "manual") {
  let path: string;
  try { path = findClaudeTranscript(configDir, sessionId); } catch { return 0; }
  let text = ""; try { text = readFileSync(path, "utf8"); } catch { return 0; }
  return new Set(text.split(/\r?\n/).flatMap(line => {
    try {
      const record = JSON.parse(line) as RecordValue;
      return record.type === "system" && record.subtype === "compact_boundary" && record.compactMetadata?.trigger === trigger
        ? [String(record.uuid ?? record.timestamp)] : [];
    } catch { return []; }
  })).size;
}
