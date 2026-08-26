import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Rpc } from "./codex-app-server";
import type { LauncherEvent } from "./common";

export const openAiDocsSkillPath = join(
  homedir(),
  ".codex",
  "skills",
  ".system",
  "openai-docs",
  "SKILL.md",
);

type SkillCall = {
  id: string;
  type: string;
  receivedAt: string | null;
  success: boolean;
};

export type SkillContractEvidence = {
  skillPath: string;
  skillSha256: string;
  skillLines: number;
  archiveTransport: boolean;
  archiveComplete: boolean;
  archiveCompletedAt: string | null;
  firstWorkItemId: string | null;
  firstWorkStartedAt: string | null;
  firstWorkWasSkillRead: boolean;
  skillReadAfterArchive: boolean;
  skillReadComplete: boolean;
  calls: SkillCall[];
};

function normalize(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\r\n?/g, "\n")
    .toLowerCase();
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(strings);
}

function workItem(message: Rpc): Record<string, any> | undefined {
  const item = message.params?.item;
  return item && ["commandExecution", "mcpToolCall"].includes(item.type) ? item : undefined;
}

function targetsSkill(item: Record<string, any>, skillPath: string): boolean {
  const identity = normalize(JSON.stringify({
    command: item.command,
    arguments: item.arguments,
    tool: item.tool,
    server: item.server,
  }));
  const exact = normalize(skillPath);
  return identity.includes(exact)
    || (identity.includes("openai-docs") && identity.includes("skill.md"));
}

function completeRead(items: Record<string, any>[], expected: string, skillPath: string): boolean {
  const output = normalize(items.flatMap(item => strings({
    aggregatedOutput: item.aggregatedOutput,
    result: item.result,
    output: item.output,
  })).join("\n"));
  const normalizedExpected = normalize(expected);
  if (output.includes(normalizedExpected)) return true;
  const lines = normalizedExpected.split("\n").map(line => line.trim()).filter(Boolean);
  let offset = 0;
  return lines.every(line => {
    const found = output.indexOf(line, offset);
    if (found < 0) return false;
    offset = found + line.length;
    return true;
  }) || items.some(item => {
    const command = normalize(String(item.command ?? ""));
    const first = lines[0] ?? "";
    const last = lines.at(-1) ?? "";
    const firstAt = output.indexOf(first);
    const lastAt = output.lastIndexOf(last);
    return command.includes("get-content")
      && command.includes("-raw")
      && command.includes(normalize(skillPath))
      && firstAt >= 0
      && lastAt >= firstAt;
  });
}

export function skillContractEvidence(
  messages: Rpc[],
  launcherEvents: LauncherEvent[],
  turnId: string,
  traceId: string,
  skillPath = openAiDocsSkillPath,
): SkillContractEvidence {
  const expected = readFileSync(skillPath, "utf8");
  const turnMessages = messages.filter(message => message.params?.turnId === turnId);
  const started = turnMessages.filter(message => message.method === "item/started" && workItem(message));
  const completed = turnMessages.filter(message => message.method === "item/completed" && workItem(message));
  const skillStarted = started.filter(message => targetsSkill(workItem(message)!, skillPath));
  const skillCompleted = completed.filter(message => targetsSkill(workItem(message)!, skillPath));
  const successfulItems = skillCompleted.flatMap(message => {
    const item = workItem(message)!;
    const success = item.status === "completed" && item.error == null
      && (item.exitCode === undefined || item.exitCode === null || item.exitCode === 0);
    return success ? [item] : [];
  });
  const traceEvents = launcherEvents.filter(event => JSON.stringify(event).includes(traceId));
  const archiveTransport = traceEvents.find(event => (
    JSON.stringify(event).includes("transport=native2-archive")
  ));
  const archiveComplete = traceEvents.find(event => (
    JSON.stringify(event).includes("served context chunk=")
    && JSON.stringify(event).includes("complete=true")
  ));
  const firstWork = started[0];
  const firstSkill = skillStarted[0];
  const archiveAt = archiveComplete?.at ?? null;
  const skillAt = firstSkill?.receivedAt ?? null;
  return {
    skillPath,
    skillSha256: createHash("sha256").update(expected).digest("hex"),
    skillLines: expected.split(/\r?\n/).length,
    archiveTransport: archiveTransport !== undefined,
    archiveComplete: archiveComplete !== undefined,
    archiveCompletedAt: archiveAt,
    firstWorkItemId: firstWork?.params?.item?.id ?? null,
    firstWorkStartedAt: firstWork?.receivedAt ?? null,
    firstWorkWasSkillRead: Boolean(firstWork && targetsSkill(workItem(firstWork)!, skillPath)),
    skillReadAfterArchive: Boolean(archiveAt && skillAt && Date.parse(skillAt) >= Date.parse(archiveAt)),
    skillReadComplete: successfulItems.length > 0 && completeRead(successfulItems, expected, skillPath),
    calls: skillCompleted.map(message => {
      const item = workItem(message)!;
      return {
        id: String(item.id ?? ""),
        type: String(item.type ?? ""),
        receivedAt: message.receivedAt ?? null,
        success: item.status === "completed" && item.error == null
          && (item.exitCode === undefined || item.exitCode === null || item.exitCode === 0),
      };
    }),
  };
}

export function hasLocalFileEvidence(
  messages: Rpc[],
  turnId: string,
  targetPath: string,
  finalText: string,
): boolean {
  const target = normalize(targetPath);
  const readCompleted = messages.some(message => {
    if (message.method !== "item/completed" || message.params?.turnId !== turnId) return false;
    const item = workItem(message);
    if (!item || item.status !== "completed" || item.error != null) return false;
    const identity = normalize(JSON.stringify({
      command: item.command,
      arguments: item.arguments,
      result: item.result,
      output: item.output,
      aggregatedOutput: item.aggregatedOutput,
    }));
    return identity.includes(target);
  });
  const evidenceText = finalText.replaceAll("**", "");
  const lineReferences = evidenceText.match(
    /(?:\bline\s+\d+(?:\s*[-–—]\s*\d+)?\b|第\s*\d+(?:\s*[-–—]\s*\d+)?\s*行|:\d+(?:\s*[-–—]\s*\d+)?\b)/gi,
  ) ?? [];
  return readCompleted && lineReferences.length >= 2;
}

export function selfTestSkillContract(): void {
  const expected = readFileSync(openAiDocsSkillPath, "utf8");
  const now = new Date().toISOString();
  const evidence = skillContractEvidence([{
    method: "item/started",
    receivedAt: now,
    params: { turnId: "turn", item: { id: "read", type: "commandExecution", command: `Get-Content -Raw '${openAiDocsSkillPath}'` } },
  }, {
    method: "item/completed",
    receivedAt: now,
    params: { turnId: "turn", item: { id: "read", type: "commandExecution", command: `Get-Content -Raw '${openAiDocsSkillPath}'`, aggregatedOutput: expected, status: "completed", exitCode: 0 } },
  }], [{ at: now, event: "runtime.daemon_stdout", message: "trace transport=native2-archive served context chunk=1/1 complete=true" }], "turn", "trace");
  if (!evidence.archiveTransport || !evidence.archiveComplete || !evidence.firstWorkWasSkillRead
    || !evidence.skillReadAfterArchive || !evidence.skillReadComplete) {
    throw new Error("skill contract evidence self-test failed");
  }
  const encodedPath = openAiDocsSkillPath.replaceAll("\\", "\\\\");
  const transportEncoded = expected.replace(/[^\x00-\x7f]/, "?");
  const encodedEvidence = skillContractEvidence([{
    method: "item/started",
    receivedAt: now,
    params: { turnId: "turn", item: { id: "read", type: "commandExecution", command: `Get-Content -Raw '${encodedPath}'` } },
  }, {
    method: "item/completed",
    receivedAt: now,
    params: { turnId: "turn", item: { id: "read", type: "commandExecution", command: `Get-Content -Raw '${encodedPath}'`, aggregatedOutput: transportEncoded, status: "completed", exitCode: 0 } },
  }], [{ at: now, event: "runtime.daemon_stdout", message: "trace transport=native2-archive served context chunk=1/1 complete=true" }], "turn", "trace");
  if (!encodedEvidence.skillReadComplete) {
    throw new Error("transport-encoded skill read evidence self-test failed");
  }
  const target = "G:\\repo\\tests\\target.test.ts";
  const localMessages: Rpc[] = [{
    method: "item/completed",
    receivedAt: now,
    params: {
      turnId: "turn",
      item: { id: "local", type: "commandExecution", command: `Get-Content -Raw '${target}'`, status: "completed", exitCode: 0 },
    },
  }];
  if (!hasLocalFileEvidence(localMessages, "turn", target, "第一項在第 10 行，第二項在 line 20。")) {
    throw new Error("local file evidence self-test failed");
  }
  if (!hasLocalFileEvidence(localMessages, "turn", target, "第一項在第 38–49 行，第二項在第 51–77 行。")) {
    throw new Error("local file evidence rejected valid line-range references");
  }
  if (hasLocalFileEvidence(localMessages, "turn", target, "只有泛泛的本機結論。")) {
    throw new Error("local file evidence accepted a report without line references");
  }
}
