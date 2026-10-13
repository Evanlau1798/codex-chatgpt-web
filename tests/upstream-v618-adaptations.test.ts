import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserDiagnostics } from "../src/adapters/chatgpt-web/browser-diagnostics";
import { parseLauncherHelperMessage } from "../src/adapters/chatgpt-web/launcher-helper-protocol";

test("persistent helper preserves generation activity as a distinct event", () => {
  expect(parseLauncherHelperMessage(JSON.stringify({ type: "event", id: "owned", event: "generation_progress" })))
    .toEqual({ type: "event", id: "owned", event: "generation_progress" });
});
import { ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-feeds";
import { withoutRetiredTurnHandles } from "../src/adapters/chatgpt-web/prompt-multipart";
import { ChatGptTurnSession, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";

test("positive generation activity reaches source observers while hidden liveness stays invisible", () => {
  const feed = new ChatGptTraceFeed();
  let activity = 0;
  const stop = (feed as any).observeProgress?.(() => activity++);
  feed.signalProgress();
  expect(activity).toBe(0);
  expect(feed.drain()).toEqual([]);
  (feed as any).recordProgress?.();
  expect(activity).toBe(1);
  expect(feed.drain()).toEqual([]);
  feed.push({ kind: "commentary", text: "Working" });
  expect(activity).toBe(2);
  expect(feed.drain()).toEqual([{ kind: "commentary", text: "Working" }]);
  stop?.();
  (feed as any).recordProgress?.();
  expect(activity).toBe(2);
});

test("the extracted serializer escapes Markdown delimiters without changing decoded context", () => {
  const source = { "`key`": ['```ts\nconst k = "`value`";\n``` '.repeat(100), "\\u0060", "\\`", "中文"] };
  const encoded = withoutRetiredTurnHandles(JSON.stringify(source));
  expect(encoded).not.toContain("`");
  expect(JSON.parse(encoded)).toEqual(source);
});

test("accepted tool batches and delivered results renew source progress without visible output", () => {
  const trace = new ChatGptTraceFeed();
  let progress = 0;
  trace.observeProgress(() => progress++);
  const session = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve("turn_source"),
    browser: new Promise<string>(() => {}), trace, text: new ChatGptTextFeed(), cancel() {},
    usageInput: { modelId: "chatgpt-web/codex", stream: true, options: {}, context: { messages: [] } } });
  session.setOutstanding([{ callId: "source-call", wireName: "exec_command", freeform: false, arguments: {} }]);
  expect(progress).toBe(1);
  session.markResultDelivered("source-call");
  expect(progress).toBe(2);
  expect(trace.drain()).toEqual([]);
});

test("failed-turn safe logs include the bounded response structure without conversation content", async () => {
  const root = mkdtempSync(join(tmpdir(), "response-structure-log-"));
  const node = { parent: -1, tag: "article", rendered: true, assistant: false, user: false,
    searchUnit: false, markdown: false, streamingStatus: false, activityStart: false, completionControl: false };
  const logged: string[] = [];
  const log = spyOn(console, "info").mockImplementation(message => { logged.push(String(message)); });
  try {
    const page = { isClosed: () => false, evaluate: async () => ({}),
      locator: () => ({ evaluateAll: async () => [{ truncated: false, nodes: [node] }] }) };
    await new ChatGptBrowserDiagnostics("structure_test", root).capture(page as never, "turn-failed");
    const structure = logged.filter(line => line.includes("response_structure"));
    expect(structure).toHaveLength(1);
    expect(structure[0]).toContain('"article"');
    expect(structure[0]).not.toContain(root);
    expect(structure[0]).not.toContain("text");
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
