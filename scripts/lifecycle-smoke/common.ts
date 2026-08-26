import { appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getConfigPath, loadConfig } from "../../src/config";
import { findClaudeTranscript, smokePath } from "./paths";
import { saveLifecycleJson } from "./artifacts";
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
  || Bun.which("codex")
  || (process.platform === "win32" ? "codex.exe" : "codex");
export const claudeExe = process.env.CODEX_LIFECYCLE_CLAUDE_EXE?.trim()
  || Bun.which("claude")
  || (process.platform === "win32" ? "claude.exe" : "claude");
export const steeringText = "這是測試訊息追加功能的訊息，有看到的話請回應";
export const auditPrompt = `請只根據你在這個 Web 對話中實際可見的上下文回答，不使用工具、不要推測，也不要引用無關的 system/developer instructions：
1.「${steeringText}」第一次出現時，是獨立 user message、system/developer message，還是附加在某次 tool result 內？
2. 若仍可見，請只原樣抄錄該訊息緊鄰的前一句與後一句控制文字。
3. 你總共看到該訊息幾次？請列出每次所在的位置。
4. 你是在 codegraph_status 的工具結果之後、下一個工具呼叫之前，還是只在最終回答前第一次看到它？
5. 相鄰控制文字是否要求你單獨確認收到、重複提及它或停止原任務？`;
export const reviewTaskPrompt = `請從 ${repoTests} 與其直接對應的 production 實作中自行選擇恰好五個尚未檢查的檔案，進行一輪深入的唯讀 code review；讀完五個檔案就立即總結本輪，不要繼續擴張範圍或派發 subagent。找出可能造成誤判、漏測或與 production 行為不一致的問題，逐項提供具體檔名與行號，並記錄已完成範圍與過程中實際遇到的摩擦。不要修改檔案、執行測試或存取網路。`;

function numberedAuditSequences(text: string): string[][] {
  const starts = [...text.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?1[.、]/gm)];
  return starts.flatMap(first => {
    const answers: string[] = [];
    let contentStart = first.index + first[0].length;
    for (let number = 2; number <= 5; number += 1) {
      const next = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${number}[.、]`, "m").exec(text.slice(contentStart));
      if (!next) return [];
      answers.push(text.slice(contentStart, contentStart + next.index));
      contentStart += next.index + next[0].length;
    }
    const tail = text.slice(contentStart);
    const end = /\n(?:以上五題|#{1,6}\s+(?:本輪|Findings|已完成))/m.exec(tail);
    answers.push(end ? tail.slice(0, end.index) : tail.slice(0, 1_000));
    return [answers];
  });
}

export function steeringAuditPassed(text: string): boolean {
  return numberedAuditSequences(text).some(answers => {
    const first = answers[0]!.replace(/\s+/g, " ");
    const count = answers[2]!.replace(/\s+/g, " ");
    const controls = answers[4]!.replace(/\s+/g, " ");
    const exactLiteralCount = /(?:看到|總共看到|共).{0,30}(?:\*\*)?(?:2|兩)\s*次/.test(count)
      || /字面.{0,45}(?:\*\*)?(?:2|兩)\s*次/.test(count);
    return /tool[- ]result|工具結果/i.test(first)
      && exactLiteralCount
      && /(?:不要求|不要|沒有(?:要求)?)/.test(controls)
      && /(?:(?:重複|反覆)(?:提及|引用)|再次.{0,20}(?:acknowledge|確認))/i.test(controls)
      && /停止/.test(controls);
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

export async function waitRootRequestBudget(previousRequestAt: number, minimumMs = 300_000) {
  const remaining = minimumMs - (Date.now() - previousRequestAt);
  if (remaining > 0) await sleep(remaining);
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
  const rateLimited = /\bHTTP(?: status)?\s*[:=]?\s*429\b|"(?:status|statusCode|code)"\s*:\s*429\b|\bstatus(?: code)?\s*[=:]\s*429\b|\b429\s+(?:too many requests|rate limit)/i.test(text);
  if (rateLimited || /too many requests|temp(?:orary)? ban|temporarily blocked|verify you are human/i.test(text)) {
    throw new Error("RATE_OR_VERIFICATION_LIMIT");
  }
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
    && !/(?:cannot|unable|could not|無法(?:完成|讀取|處理)|不能完成)/i.test(text);
}
export function save(path: string, value: unknown) { saveLifecycleJson(path, value); }

export async function selfTest() {
  assert(count("x-x-x", "x") === 3, "count self-test failed");
  assert(successfulReport("已分析第 1 部分，範圍 00000–00259", ["第 1 部分", "00000", "00259"]), "positive report self-test failed");
  assert(successfulReport("已分析第 1 部分，範圍 00000–00259；沒有使用工具，也沒有遇到傳輸摩擦", ["第 1 部分", "00000", "00259"]), "no-friction report self-test failed");
  assert(!successfulReport("cannot finish 第 1 部分 00000 00259", ["第 1 部分", "00000", "00259"]), "refused report self-test failed");
  assert(!successfulReport("無法讀取第 1 部分 00000 00259", ["第 1 部分", "00000", "00259"]), "Chinese refusal self-test failed");
  const audit = `## 1. 附加在 tool result 內\n## 2. before and after\n## 3. 總共看到 2 次\n## 4. at the tool boundary\n## 5. 不要求重複提及，也不要求停止`;
  assert(steeringAuditPassed(audit), "steering audit self-test failed");
  assert(steeringAuditPassed(`1. decoy\n2. decoy\n${audit}`), "numbered prelude must not hide the audit answers");
  assert(steeringAuditPassed(audit.replace("總共看到 2 次", "共 2 次")), "natural count wording failed");
  assert(steeringAuditPassed(audit.replace(
    "總共看到 2 次",
    "若以「那次追加 guidance 事件」計，共 1 次：在上述 Read tool result 尾端。若純粹計算這串文字目前的字面出現，則是 2 次：第一次是 guidance，第二次是這一輪問題引用它。",
  )), "event-versus-literal count wording failed");
  assert(steeringAuditPassed(audit.replace("不要求重複提及", "沒有要求我反覆提及")), "equivalent audit wording failed");
  assert(steeringAuditPassed(audit.replace(
    "不要求重複提及，也不要求停止",
    "相鄰控制文字明確說不要再次 acknowledge，也不要因此停止目前任務",
  )), "acknowledge wording from the live Claude audit failed");
  const multilineAudit = audit.replace(
    "5. 不要求重複提及，也不要求停止",
    "5. 相鄰控制文字沒有要求我：\n- 重複引用該訊息；\n- 停止原任務。",
  );
  assert(steeringAuditPassed(multilineAudit), "multiline equivalent audit wording failed");
  assert(steeringAuditPassed(audit.replace(
    "不要求重複提及，也不要求停止",
    "不要再次套用或確認它，也不要因此停止目前任務",
  )), "historical-guidance control wording failed");
  assert(!steeringAuditPassed(audit.replace("附加在 tool result 內", "獨立 user message")), "wrong steering origin passed");
  assert(!steeringAuditPassed(audit.replace("不要求重複提及，也不要求停止", "確實要求重複引用，也要求停止")), "positive control request passed");
  assert(!steeringAuditPassed(audit.replace("2 次", "3 次")), "duplicate steering audit self-test failed");
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
