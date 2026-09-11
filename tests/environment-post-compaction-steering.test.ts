import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";

const temporaryRoots: string[] = [];
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const threadId = "01a08527-37bf-73a3-9ddd-342642aa2ce8";
const turnId = "01a08fa0-626b-7881-bb75-6d7923f4e087";
const sourceTurnId = "01a08e44-6c26-7002-b3c5-b62e5ded10cf";
const childThreadId = "01a08fff-0000-7000-8000-000000000001";
const parentThreadId = "01a08fff-0000-7000-8000-000000000002";
const childTurnId = "01a08fff-0000-7000-8000-000000000003";

function fixture(options: {
  checkpointKind?: "v1" | "v2"; child?: boolean; environment?: string; remember?: boolean;
  threadId?: string; turnId?: string;
} = {}) {
  const { checkpointKind = "v2", child = false } = options;
  const nativeThreadId = options.threadId ?? (child ? childThreadId : threadId);
  const nativeTurnId = options.turnId ?? (child ? childTurnId : turnId);
  const root = resolve(process.cwd());
  const codexHome = mkdtempSync(join(tmpdir(), "codex-post-compact-steering-"));
  temporaryRoots.push(codexHome);
  const rollout = join(codexHome, "sessions", "2026", "09", "11", `rollout-2026-09-11T16-40-47-${nativeThreadId}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, [
    JSON.stringify({ type: "session_meta", payload: child ? {
      id: nativeThreadId, parent_thread_id: parentThreadId, thread_source: "subagent", agent_path: "/root/reviewer",
      source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, agent_path: "/root/reviewer" } } },
    } : { id: nativeThreadId, source: "vscode" } }),
    JSON.stringify({ type: "turn_context", payload: {
      turn_id: nativeTurnId, cwd: root, workspace_roots: [root], approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" },
    } }),
  ].join("\n") + "\n");

  const environment = options.environment ?? `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const summary = "The current task continues after a verified compact checkpoint.";
  const current = {
    type: "message", role: "user", id: "msg_current_compacted",
    content: [
      { type: "input_text", text: "Current system and developer context." },
      { type: "input_text", text: "Review the candidate." },
      { type: "input_text", text: environment },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: nativeTurnId },
  };
  const source = child ? {
    type: "agent_message", id: "amsg_compaction_source", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Continue the existing review." }],
  } : {
    type: "message", role: "user", id: "msg_compaction_source",
    content: [{ type: "input_text", text: "Continue the existing review." }],
    internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
  };
  const checkpoint = checkpointKind === "v2"
    ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
    : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] };
  const body = {
    model: "chatgpt-web/extra-high",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn", thread_id: nativeThreadId, turn_id: nativeTurnId,
      ...(child ? { parent_thread_id: parentThreadId, agent_name: "/root/reviewer", subagent_kind: "thread_spawn" } : {}),
      sandbox_mode: "danger-full-access", workspaces: { [root]: {} },
    }) },
    input: [current, source, checkpoint] as Array<Record<string, unknown>>,
  };
  const parsed = parseRequest(body);
  if (options.remember !== false) {
    rememberCompactionContinuation(
      { ...parsed, _compactionRequest: true },
      extractChatGptTurnIdentity(parsed),
      [{ ...(child ? {} : { turnId: sourceTurnId }), itemId: source.id, content: source.content }],
      summary,
    );
  }
  return { body, codexHome, root };
}

test("same-turn steering after an accepted compact checkpoint recovers the exact rollout environment", () => {
  const { body, codexHome, root } = fixture();
  body.input.push({
    type: "message", role: "user", id: "msg_steering",
    content: [{ type: "input_text", text: "Keep the review read-only and finish promptly." }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)).cwd).toBe(root);
});

test("same-turn steering after a V1 compact checkpoint recovers the exact rollout environment", () => {
  const { body, codexHome, root } = fixture({ checkpointKind: "v1" });
  body.input.push({
    type: "message", role: "user", id: "msg_steering_v1",
    content: [{ type: "input_text", text: "Finish the retained review." }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)).cwd).toBe(root);
});

test("post-compaction steering still validates the current environment claim", () => {
  const { body, codexHome } = fixture({ environment: "<environment_context><cwd/></environment_context>" });
  body.input.push({
    type: "message", role: "user", id: "msg_steering_after_bad_environment",
    content: [{ type: "input_text", text: "Finish the retained review." }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)))
    .toThrow();
});

test("post-compaction steering rejects an extra malformed current environment claim", () => {
  const { body, codexHome } = fixture();
  const current = body.input[0] as { content: Array<{ type: string; text: string }> };
  current.content.push({ type: "input_text", text: "<environment_context><cwd/></environment_context> trailing" });
  body.input.push({
    type: "message", role: "user", id: "msg_steering_after_extra_bad_environment",
    content: [{ type: "input_text", text: "Finish the retained review." }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)))
    .toThrow();
});

test("V2 child parent steering after a compact checkpoint recovers its exact rollout environment", () => {
  const { body, codexHome, root } = fixture({ child: true });
  body.input.push({
    type: "agent_message", id: "amsg_followup", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Finish the retained child review." }],
  });

  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)).cwd).toBe(root);
});

test("V2 child parent steering cannot cross an unaccepted compact checkpoint", () => {
  const { body, codexHome } = fixture({
    child: true,
    remember: false,
    threadId: "01a08fff-0000-7000-8000-000000000004",
    turnId: "01a08fff-0000-7000-8000-000000000005",
  });
  body.input.push({
    type: "agent_message", id: "amsg_unaccepted_followup", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Finish the retained child review." }],
  });

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)))
    .toThrow();
});

test("a new malformed environment after the checkpoint still fails closed", () => {
  const { body, codexHome } = fixture();
  body.input.push({
    type: "message", role: "user", id: "msg_invalid_environment",
    content: [{ type: "input_text", text: "<environment_context><cwd/></environment_context>" }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parseRequest(body)))
    .toThrow();
});
