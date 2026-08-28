import { appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getConfigPath, loadConfig } from "../../src/config";
import { findClaudeTranscript, resolveLifecycleExecutable, smokePath } from "./paths";
import { isRateOrVerificationLimit, saveLifecycleJson } from "./artifacts";
import { fetchWithTimeout } from "./run-guard";
import { LauncherEventReader, type LauncherEvent } from "./launcher-event-reader";

const runtimeConfig = loadConfig();
const defaultLauncherUserData = process.platform === "win32"
  ? join(process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "Codex Web GPT")
  : process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Codex Web GPT")
    : join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "Codex Web GPT");

export const repo = join(import.meta.dir, "..", "..");
export const repoTests = smokePath(repo, "tests");
export const serviceBaseUrl = `http://${runtimeConfig.host}:${runtimeConfig.port}`;
export const launcherLog = process.env.CODEX_LIFECYCLE_LAUNCHER_LOG?.trim()
  || join(defaultLauncherUserData, "logs", "launcher.jsonl");
export const browserDescriptor = process.env.CODEX_LIFECYCLE_BROWSER_DESCRIPTOR?.trim()
  || runtimeConfig.browserHostDescriptorPath
  || "";
export const codexExe = process.env.CODEX_LIFECYCLE_CODEX_EXE?.trim()
  || resolveLifecycleExecutable("codex");
export const claudeExe = process.env.CODEX_LIFECYCLE_CLAUDE_EXE?.trim()
  || resolveLifecycleExecutable("claude");
export const steeringText = "Respond only in English. Lifecycle smoke marker ENGLISH_STEERING_VISIBLE is present; continue the original task and do not stop or answer only about this marker.";
export const auditPrompt = `Audit only the earlier lifecycle steering guidance containing marker ENGLISH_STEERING_VISIBLE, not this current audit request. At the end of the current task's final answer, append exactly three short audit lines. Use exactly the labels "1." through "3.". Do not use blockquotes, tools, speculation, or unrelated system or developer instructions:
1. State whether that earlier steering guidance appeared appended to a tool result or as a standalone user, system, or developer message.
2. State how many literal occurrences of the steering message are present in that earlier guidance. Do not repeat the marker text.
3. State whether the adjacent control text asked you to acknowledge it separately, mention it repeatedly, or stop the original task.`;
export const reviewTaskPrompt = `Respond only in English. Select exactly five files that you have not inspected from ${repoTests} and their directly corresponding production implementations, then perform one in-depth read-only code review round. Summarize immediately after reading those five files; do not expand the scope or dispatch a subagent. Report concrete file and line evidence for issues that may cause false positives, missed coverage, or divergence from production behavior, and record the completed scope and any actual friction. Do not modify files, run tests, or access the network.`;

function numberedAuditSequences(text: string): string[][] {
  const starts = [...text.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?1[.)]/gm)];
  return starts.flatMap(first => {
    const answers: string[] = [];
    let contentStart = first.index + first[0].length;
    for (let number = 2; number <= 3; number += 1) {
      const next = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${number}[.)]`, "m").exec(text.slice(contentStart));
      if (!next) return [];
      answers.push(text.slice(contentStart, contentStart + next.index));
      contentStart += next.index + next[0].length;
    }
    const tail = text.slice(contentStart);
    const end = /\n(?:Answers complete|#{1,6}\s+(?:Round|Findings|Completed))/im.exec(tail);
    answers.push(end ? tail.slice(0, end.index) : tail.slice(0, 1_000));
    return [answers];
  });
}

export function steeringAuditPassed(text: string): boolean {
  return numberedAuditSequences(text).some(answers => {
    const first = answers[0]!.replace(/\s+/g, " ");
    const count = answers[1]!.replace(/\s+/g, " ");
    const controls = answers[2]!.replace(/\s+/g, " ");
    const exactLiteralCount = /(?:saw|see|seen|total|appears?|occurrences?|literal).{0,60}(?:\*\*)?(?:1|one)(?:\*\*)?|(?:\*\*)?(?:1|one)(?:\*\*)?\s+(?:literal\s+)?(?:times?|occurrences?)/i.test(count);
    const explicitControlDenial = /(?:did not|does not|do not|no|not asked|wasn't asked)/i.test(controls)
      && /(?:repeat(?:ed|edly|ing)?|repetit(?:ion|ive)|mention|quote|acknowledg(?:e|ment)?)/i.test(controls)
      && /\bstop(?:ping)?\b/i.test(controls);
    return /tool[- ]result/i.test(first)
      && exactLiteralCount
      && (explicitControlDenial || /\bnone of (?:those|these)\b/i.test(controls));
  });
}

export type { LauncherEvent } from "./launcher-event-reader";
export type Timeline = Record<string, string | number | null>;
export type LaneResult = {
  status: "passed" | "failed" | "blocked";
  lane: "claude" | "codex";
  sessionId?: string;
  threadId?: string;
  checks: Record<string, boolean>;
  timelines: Timeline[];
  artifacts: Record<string, string>;
  message?: string;
};

export function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
export function sleep(ms: number) { return Bun.sleep(ms); }
export function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

const launcherEventReader = new LauncherEventReader();

export function events(since = 0): LauncherEvent[] {
  let paths: string[] = [];
  try {
    const name = basename(launcherLog);
    paths = readdirSync(dirname(launcherLog))
      .filter(value => value === name || value.startsWith(`${name}.`))
      .map(value => join(dirname(launcherLog), value));
  } catch { return []; }
  return launcherEventReader.read(paths, since);
}

export async function waitForEvent(
  since: number,
  event: string,
  timeoutMs: number,
  predicate: (value: LauncherEvent) => boolean = () => true,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events(since).findLast(value => value.event === event && predicate(value));
    if (found) return found;
    detectRestriction(events(since));
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${event}`);
}

export async function waitCreateBudget(minimumMs = 30_000) {
  const latest = events().findLast(value => value.event === "browser.tab_created");
  if (!latest) return;
  const remaining = minimumMs - (Date.now() - Date.parse(latest.at));
  if (remaining > 0) await sleep(remaining);
}

export const rootRequestCooldownMs = 60_000;

export function rootRequestCooldownRemaining(
  previousRequestAt: number,
  now = Date.now(),
  minimumMs = rootRequestCooldownMs,
): number {
  return Math.max(0, minimumMs - (now - previousRequestAt));
}

export async function waitRootRequestBudget(previousRequestAt: number, minimumMs = rootRequestCooldownMs) {
  const remaining = rootRequestCooldownRemaining(previousRequestAt, Date.now(), minimumMs);
  if (remaining > 0) await sleep(remaining);
}

type CleanupAction = () => Promise<unknown>;

export async function cleanupLifecycleResources(...phases: CleanupAction[][]): Promise<void> {
  const errors: unknown[] = [];
  for (const phase of phases) {
    const results = await Promise.allSettled(phase.map(action => action()));
    errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Lifecycle smoke cleanup failed (${errors.length} errors)`);
  }
}

export async function waitSteeringPoint(since: number, traceId: string, deliveryTimeoutMs = 300_000) {
  await waitForEvent(since, "runtime.daemon_stdout", 300_000, value => JSON.stringify(value).includes(traceId) && JSON.stringify(value).includes("stage=response_visible"));
  const deadline = Date.now() + deliveryTimeoutMs;
  while (Date.now() < deadline) {
    const current = events(since);
    const ready = current.some(value => {
      const line = JSON.stringify(value);
      return line.includes(traceId)
        && (line.includes("stage=adapter_first_commentary") || line.includes("queued call="));
    });
    if (ready) return true;
    if (current.some(value => value.event === "browser.tab_completed" && value.detail?.traceId === traceId)) {
      throw new Error("Web turn completed before a steering delivery point");
    }
    detectRestriction(current);
    await sleep(500);
  }
  throw new Error("Web turn did not reach a tool boundary for steering");
}

export async function submitClaudeSteering(sessionId: string, prompt: string, configDir?: string) {
  const timestamp = iso();
  const transcript = findClaudeTranscript(configDir ?? join(homedir(), ".claude"), sessionId);
  appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp, sessionId, content: prompt })}\n`);
  const config = await Bun.file(getConfigPath()).json() as {
    host: string; port: number; controlToken: string;
  };
  const response = await fetchWithTimeout(
    `http://${config.host}:${config.port}/v1/messages/steering`, 10_000, "Claude steering hook", fetch, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt }),
    },
  );
  assert(response.status === 204, `Claude steering hook failed: HTTP ${response.status}`);
}

export async function cutoff(tabId: string) {
  assert(browserDescriptor, "Lifecycle smoke requires a launcher browser descriptor");
  const descriptor = await Bun.file(browserDescriptor).json();
  const response = await fetchWithTimeout(
    `${descriptor.control.endpoint}/v1/debug/turn/cutoff`, 10_000, "Browser cutoff cleanup", fetch, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tabId }),
    },
  );
  if (response.status !== 200 && response.status !== 404) throw new Error(`cutoff ${tabId} failed: ${response.status}`);
}

export function detectRestriction(values: LauncherEvent[], extra = "") {
  const text = `${extra}\n${values.map(value => `${value.event} ${value.message ?? ""} ${JSON.stringify(value.detail ?? {})}`).join("\n")}`;
  if (isRateOrVerificationLimit(text)) throw new Error("RATE_OR_VERIFICATION_LIMIT");
}

export function stageTimeline(since: number, traceId: string, client: Partial<Timeline>): Timeline {
  const lines = events(since).filter(value => JSON.stringify(value).includes(traceId));
  const stageAt = (stage: string) => lines.find(value => `${value.message ?? ""} ${JSON.stringify(value.detail ?? {})}`.includes(`stage=${stage}`))?.at ?? null;
  const request = typeof client.request_sent === "string" ? Date.parse(client.request_sent) : since;
  const visible = stageAt("response_visible");
  const commentary = stageAt("web_first_commentary");
  const adapter = stageAt("adapter_first_commentary");
  const firstText = typeof client.client_first_text === "string" ? client.client_first_text : null;
  const delta = (end: string | null, start: string | null) => end && start ? Date.parse(end) - Date.parse(start) : null;
  const commentaryEvent = lines.find(value => `${value.message ?? ""} ${JSON.stringify(value.detail ?? {})}`.includes("stage=adapter_first_commentary"));
  const stable = JSON.stringify(commentaryEvent ?? {}).match(/stableMs=(\d+)/)?.[1] ?? null;
  return {
    ...client,
    response_visible: visible,
    web_first_status: stageAt("web_first_status"),
    web_first_commentary: commentary,
    adapter_first_commentary: adapter,
    web_ttft_ms: visible ? Date.parse(visible) - request : null,
    web_commentary_stable_ms: stable === null ? null : Number(stable),
    adapter_to_cli_ms: delta(firstText, adapter),
    web_commentary_to_cli_ms: delta(firstText, commentary),
  };
}

export function count(text: string, needle: string) { return text.split(needle).length - 1; }
export function successfulReport(text: string, expected: string[]) {
  return expected.every(value => text.includes(value))
    && !/(?:cannot|unable|could not)/i.test(text);
}
export function save(path: string, value: unknown) { saveLifecycleJson(path, value); }

export async function selfTest() {
  assert(count("x-x-x", "x") === 3, "count self-test failed");
  assert(successfulReport("Analyzed part 1, range 00000–00259", ["part 1", "00000", "00259"]), "positive report self-test failed");
  assert(successfulReport("Analyzed part 1, range 00000–00259; no tools or transport friction", ["part 1", "00000", "00259"]), "no-friction report self-test failed");
  assert(!successfulReport("cannot finish part 1 00000 00259", ["part 1", "00000", "00259"]), "refused report self-test failed");
  const audit = `## 1. Appended to a tool result\n## 2. I saw one literal occurrence\n## 3. It did not ask me to mention it repeatedly or stop`;
  assert(steeringAuditPassed(audit), "steering audit self-test failed");
  assert(steeringAuditPassed(`1. decoy\n2. decoy\n${audit}`), "numbered prelude must not hide the audit answers");
  assert(steeringAuditPassed(audit.replace("I saw one literal occurrence", "There was 1 occurrence")), "natural count wording failed");
  assert(steeringAuditPassed(audit.replace("did not ask me to mention it repeatedly", "did not ask me to quote it again")), "equivalent audit wording failed");
  assert(steeringAuditPassed(audit.replace(
    "It did not ask me to mention it repeatedly or stop",
    "The adjacent control text says not to acknowledge it again and not to stop the current task",
  )), "acknowledge wording from the live Claude audit failed");
  const multilineAudit = audit.replace(
    "3. It did not ask me to mention it repeatedly or stop",
    "3. It did not ask me to:\n- quote the message repeatedly;\n- stop the original task.",
  );
  assert(steeringAuditPassed(multilineAudit), "multiline equivalent audit wording failed");
  assert(steeringAuditPassed(audit.replace(
    "It did not ask me to mention it repeatedly or stop",
    "Do not acknowledge it again, and do not stop the current task",
  )), "historical-guidance control wording failed");
  assert(!steeringAuditPassed(audit.replace("Appended to a tool result", "A standalone user message")), "wrong steering origin passed");
  assert(!steeringAuditPassed(audit.replace("It did not ask me to mention it repeatedly or stop", "It asked me to repeat the message and stop")), "positive control request passed");
  assert(!steeringAuditPassed(audit.replace("one literal occurrence", "two literal occurrences")), "duplicate steering audit self-test failed");
  const sample = [{ at: iso(), event: "browser.note", message: "ok" }];
  detectRestriction(sample);
  detectRestriction([{
    at: iso(),
    event: "runtime.daemon_stdout",
    detail: { line: "browser turn trace latency stage=response_visible elapsedMs=429" },
  }]);
  const orderedEvents = events(Date.now() + 1);
  assert(orderedEvents.length === 0, "future launcher event filter failed");
  let blocked = false;
  try { detectRestriction([], "HTTP 429 too many requests"); } catch { blocked = true; }
  assert(blocked, "restriction self-test failed");
}
