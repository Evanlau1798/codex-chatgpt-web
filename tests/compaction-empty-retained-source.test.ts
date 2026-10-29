import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { rememberCompletedCompaction } from "../src/responses/compaction-continuation";
import { buildCompactV1Output, encodeCompactionSummary, extractCompactUserMessages } from "../src/responses/compaction";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";

test("a child checkpoint does not invent a human alias for retained context", () => {
  const metadata = { request_kind: "turn", thread_id: "child-empty-retained", turn_id: "child-turn", parent_thread_id: "parent",
    agent_name: "/root/reviewer", subagent_kind: "thread_spawn" };
  const source = { type: "agent_message", id: "amsg_parent_task", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Complete the independent audit." }],
    internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id } };
  const context = { type: "message", role: "user", id: "msg_context_only", content: [
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Read the task.</INSTRUCTIONS>" },
    { type: "input_text", text: "<environment_context><cwd>/workspace</cwd></environment_context>" },
  ], internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id,
    content_item_kinds: ["agents_md.instructions", "environments.environment_context"] } };
  const body = { model: "chatgpt-web/high", client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    input: [context, source, { type: "compaction_trigger" }] };
  const parsed = parseRequest(body);
  const summary = "Continue the original delegated audit using the verified evidence.";
  const replacement = buildCompactV1Output(extractCompactUserMessages(body.input), summary);
  expect(() => rememberCompletedCompaction(parsed, { status: "completed",
    output: [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }] }, replacement)).not.toThrow();
  const resumed = parseRequest({ ...body, input: replacement });
  expect(extractChatGptTurnUserRevision(resumed)).toEqual(source.content);
  const unrelated = parseRequest({ ...body, input: replacement, client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ ...metadata, thread_id: "unrelated" }),
  } });
  expect(() => extractChatGptTurnUserRevision(unrelated)).toThrow();
});
