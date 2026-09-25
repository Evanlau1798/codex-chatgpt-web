import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexMessage, CodexParsedRequest } from "../src/types";
import {
  ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS,
  EnhancedRecoveryCheckpointStore,
} from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(threadId: string, messages: CodexMessage[]): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    _chatgptModelFamily: "5.6",
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "turn_current" }),
      },
    },
    context: { systemPrompt: ["authoritative system"], messages },
  };
}

function user(text: string, timestamp: number): CodexMessage {
  return { role: "user", content: text, timestamp };
}

function developer(text: string, timestamp: number): CodexMessage {
  return { role: "developer", content: text, timestamp };
}

function assistantText(text: string, timestamp: number): CodexMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

function call(id: string, timestamp: number): CodexMessage {
  return {
    role: "assistant",
    timestamp,
    content: [{ type: "toolCall", id, name: "exec_command", arguments: { cmd: id } }],
  };
}

function parallelCalls(timestamp: number): CodexMessage {
  return {
    role: "assistant",
    timestamp,
    content: [
      { type: "toolCall", id: "call_a", name: "exec_command", arguments: { cmd: "a" } },
      { type: "toolCall", id: "call_b", name: "exec_command", arguments: { cmd: "b" } },
    ],
  };
}

function result(id: string, timestamp: number): CodexMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "exec_command",
    content: `result ${id}`,
    isError: false,
    timestamp,
  };
}

test("checkpoint planning waits for a complete canonical tool-result boundary", () => {
  const store = new EnhancedRecoveryCheckpointStore();
  const prefix = [user("do the work", 1), parallelCalls(2), result("call_a", 3)];

  expect(store.shouldCheckpoint(request("thread_boundary", prefix), 1)).toBe(false);
  expect(store.shouldCheckpoint(request("thread_boundary", [...prefix, result("call_b", 4)]), 1)).toBe(true);
});

test("commit persists one checkpoint per thread and planning counts only post-checkpoint canonical tail", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-checkpoint-"));
  roots.push(root);
  const path = join(root, "state.json");
  const first = request("thread_persist", [user("start", 1), call("call_1", 2), result("call_1", 3)]);
  const store = new EnhancedRecoveryCheckpointStore(path, () => 1_000);

  store.commit(first, "first durable summary");
  expect(store.shouldCheckpoint(first, 1)).toBe(false);

  const second = request("thread_persist", [
    ...first.context.messages,
    assistantText("continued", 4),
    call("call_2", 5),
    result("call_2", 6),
  ]);
  expect(store.shouldCheckpoint(second, 1)).toBe(true);
  store.commit(second, "second durable summary");

  const payload = JSON.parse(readFileSync(path, "utf8")) as { checkpoints: Array<{ summary: string }> };
  expect(payload.checkpoints).toHaveLength(1);
  expect(payload.checkpoints[0]?.summary).toBe("second durable summary");
  expect(new EnhancedRecoveryCheckpointStore(path, () => 1_000).apply(second).applied).toBe(true);
});

test("Plus schedules the next checkpoint before a real reconstructed prompt reaches its context limit", () => {
  const store = new EnhancedRecoveryCheckpointStore();
  const source = request("thread_plus_budget", [user("task", 1), call("call_first", 2), result("call_first", 3)]);
  source.modelId = CHATGPT_WEB_MODEL_ID;
  store.commit(source, "checkpoint ".repeat(5_000));
  const secondResult = result("call_second", 5) as Extract<CodexMessage, { role: "toolResult" }>;
  const continued = request("thread_plus_budget", [
    ...source.context.messages,
    call("call_second", 4),
    { ...secondResult, content: "token ".repeat(70_000) },
  ]);
  continued.modelId = CHATGPT_WEB_MODEL_ID;
  const projected = store.apply(continued);
  expect(projected.applied).toBe(true);
  const inputTokens = estimateChatGptWebInputTokens(projected.parsed, {
    localToolsEnabled: true, solAvailable: true, proAvailable: false,
  }, { nativeControlConnector: true });
  expect(inputTokens).toBeGreaterThan(81_808);
  expect(store.shouldCheckpoint(continued, 80_000)).toBe(false);
  expect(store.shouldCheckpoint(continued, 80_000, { inputTokens, contextWindow: 90_000 })).toBe(true);
});

test("a changed canonical branch can establish a new checkpoint without replaying its old one", () => {
  const store = new EnhancedRecoveryCheckpointStore();
  const original = request("thread_branch", [user("first branch", 1), call("call_old", 2), result("call_old", 3)]);
  store.commit(original, "old branch checkpoint");
  const branched = request("thread_branch", [user("second branch", 1), call("call_new", 2), result("call_new", 3)]);
  expect(store.apply(branched).applied).toBe(false);
  expect(store.shouldCheckpoint(branched, 1)).toBe(true);
  store.commit(branched, "new branch checkpoint");
  expect(store.apply(branched).applied).toBe(true);
});

test("apply replaces only historical model messages and preserves authoritative context", () => {
  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-apply-"));
  roots.push(root);
  const path = join(root, "state.json");
  const threadId = "thread_apply";
  const prefix: CodexMessage[] = [
    developer("developer contract A", 1),
    user("historical user request", 2),
    call("call_old", 3),
    result("call_old", 4),
    user("latest user revision", 5),
    developer("developer contract B", 6),
    call("call_anchor", 7),
    result("call_anchor", 8),
  ];
  const source = request(threadId, prefix);
  new EnhancedRecoveryCheckpointStore(path, () => 5_000).commit(source, "Recovered work through the anchor.");

  const retimestampedPrefix = prefix.map(message => ({ ...message, timestamp: message.timestamp + 10_000 })) as CodexMessage[];
  const suffix = [assistantText("post-checkpoint progress", 20_000), call("call_post", 20_001), result("call_post", 20_002)];
  const crashed = request(threadId, [...retimestampedPrefix, ...suffix]);
  const originalMessages = crashed.context.messages;
  const originalRawBody = crashed._rawBody;
  const applied = new EnhancedRecoveryCheckpointStore(path, () => 5_000).apply(crashed);

  expect(applied.applied).toBe(true);
  expect(applied.parsed).not.toBe(crashed);
  expect(applied.parsed._rawBody).toBe(originalRawBody);
  expect(applied.parsed.context.systemPrompt).toBe(crashed.context.systemPrompt);
  expect(crashed.context.messages).toBe(originalMessages);
  expect(crashed.context.messages).toHaveLength(prefix.length + suffix.length);

  const encoded = JSON.stringify(applied.parsed.context.messages);
  expect(encoded).toContain("Recovered work through the anchor.");
  expect(encoded).toContain("developer contract A");
  expect(encoded).toContain("developer contract B");
  expect(encoded).toContain("latest user revision");
  expect(encoded).toContain("post-checkpoint progress");
  expect(encoded).toContain("call_post");
  expect(encoded).toContain("historical user request");
  expect(encoded).not.toContain("call_old");
});

test("apply retains every active skill and AGENTS instruction in the checkpointed prefix", () => {
  const messages: CodexMessage[] = [
    { role: "user", origin: "codex_skill", content: "skill A instruction", timestamp: 1 },
    user("# AGENTS.md instructions\nparent rule", 2),
    { role: "user", origin: "codex_skill", content: "skill B instruction", timestamp: 3 },
    user("# AGENTS.md instructions\nchild rule", 4),
    call("call_anchor", 5), result("call_anchor", 6),
  ];
  const parsed = request("thread_authority", messages);
  const store = new EnhancedRecoveryCheckpointStore();
  store.commit(parsed, "Historical work summary");
  const applied = store.apply(parsed);
  expect(applied.applied).toBe(true);
  const encoded = JSON.stringify(applied.parsed.context.messages);
  for (const instruction of ["skill A instruction", "skill B instruction", "parent rule", "child rule"]) {
    expect(encoded).toContain(instruction);
  }
});

test("an earlier user message combining context and steering retains its user instruction", () => {
  const messages: CodexMessage[] = [
    { role: "user", content: [
      { type: "text", text: "<environment_context>old</environment_context>" },
      { type: "text", text: "Keep the original files read-only" },
    ], timestamp: 1 },
    user("<environment_context>new</environment_context>", 2),
    call("call_anchor", 3), result("call_anchor", 4),
  ];
  const parsed = request("thread_mixed_authority", messages);
  const store = new EnhancedRecoveryCheckpointStore();
  store.commit(parsed, "Work summary");
  expect(JSON.stringify(store.apply(parsed).parsed.context.messages)).toContain("Keep the original files read-only");
});

test("a multipart contextual user message retains AGENTS authority after a newer environment", () => {
  const messages: CodexMessage[] = [
    { role: "user", content: [
      { type: "text", text: "<recommended_plugins>tools</recommended_plugins>" },
      { type: "text", text: "# AGENTS.md instructions\n<instructions>Keep files read-only</instructions>" },
      { type: "text", text: "<environment_context>old</environment_context>" },
    ], timestamp: 1 },
    user("<environment_context>new</environment_context>", 2),
    call("call_anchor", 3), result("call_anchor", 4),
  ];
  const parsed = request("thread_multipart_agents", messages);
  const store = new EnhancedRecoveryCheckpointStore();
  store.commit(parsed, "Work summary");
  expect(JSON.stringify(store.apply(parsed).parsed.context.messages)).toContain("Keep files read-only");
});

test("apply fails closed on identity or normalized prefix mismatch", () => {
  const threadId = "thread_mismatch";
  const messages = [user("task", 1), call("call_anchor", 2), result("call_anchor", 3)];
  const source = request(threadId, messages);
  const store = new EnhancedRecoveryCheckpointStore();
  store.commit(source, "checkpoint summary");

  const mismatches: CodexParsedRequest[] = [
    { ...request(threadId, messages), modelId: "gpt-6-sol" },
    { ...request(threadId, messages), _chatgptModelFamily: "6" },
    { ...request(threadId, messages), options: { reasoning: "medium" } },
    request(threadId, [user("changed task", 1), call("call_anchor", 2), result("call_anchor", 3)]),
  ];
  for (const mismatch of mismatches) {
    const outcome = store.apply(mismatch);
    expect(outcome.applied).toBe(false);
    expect(outcome.parsed).toBe(mismatch);
  }
});

test("commit enforces the summary cap and updates memory only after durable persistence", () => {
  const source = request("thread_durable", [user("task", 1), call("call_anchor", 2), result("call_anchor", 3)]);
  const memory = new EnhancedRecoveryCheckpointStore();
  expect(() => memory.commit(source, "token ".repeat(ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS + 1_000)))
    .toThrow("8,000");

  const root = mkdtempSync(join(tmpdir(), "enhanced-recovery-failure-"));
  roots.push(root);
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "not a directory");
  const store = new EnhancedRecoveryCheckpointStore(join(blocker, "state.json"));
  expect(() => store.commit(source, "valid summary")).toThrow();
  expect(store.apply(source).applied).toBe(false);
  expect(store.shouldCheckpoint(source, 1)).toBe(true);
});

test("store expires old checkpoints and bounds retained threads", () => {
  let now = 10_000;
  const ttlStore = new EnhancedRecoveryCheckpointStore(undefined, () => now);
  const ttlRequest = request("thread_ttl", [user("task", 1), call("ttl_call", 2), result("ttl_call", 3)]);
  ttlStore.commit(ttlRequest, "ttl summary");
  now += 31 * 24 * 60 * 60_000;
  expect(ttlStore.apply(ttlRequest).applied).toBe(false);

  const bounded = new EnhancedRecoveryCheckpointStore();
  for (let index = 0; index <= 128; index += 1) {
    const id = `thread_bound_${index}`;
    const parsed = request(id, [user("task", 1), call(`call_${index}`, 2), result(`call_${index}`, 3)]);
    bounded.commit(parsed, `summary ${index}`);
  }
  expect(bounded.apply(request("thread_bound_0", [user("task", 1), call("call_0", 2), result("call_0", 3)])).applied)
    .toBe(false);
  expect(bounded.apply(request("thread_bound_128", [user("task", 1), call("call_128", 2), result("call_128", 3)])).applied)
    .toBe(true);
});
