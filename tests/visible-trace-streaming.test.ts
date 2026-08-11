import { expect, test } from "bun:test";
import { ChatGptVisibleTraceTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptTurnLatencyDiagnostics } from "../src/adapters/chatgpt-web/turn-latency";

test("streams stable commentary prefixes while the DOM node keeps growing", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const output = [];

  output.push(...tracker.observe([
    { kind: "commentary", text: "Cod", complete: false },
  ], false, 1_000));
  output.push(...tracker.observe([
    { kind: "commentary", text: "Codex Native", complete: false },
  ], false, 1_100));
  output.push(...tracker.observe([
    { kind: "commentary", text: "Codex Native 正在讀取 `repo`", complete: false },
  ], false, 1_200));
  output.push(...tracker.observe([
    { kind: "commentary", text: "Codex Native 正在讀取 `repo`", complete: true },
  ], false, 1_201));

  expect(output).toEqual([
    { kind: "commentary", text: "Cod" },
    { kind: "commentary", text: "ex Native", continuation: true },
    { kind: "commentary", text: " 正在讀取 `repo`", continuation: true },
  ]);
  expect(output.map(event => event.text).join("")).toBe("Codex Native 正在讀取 `repo`");
});

test("waits for a non-prefix commentary rewrite to stabilize", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);

  expect(tracker.observe([
    { kind: "commentary", text: "Working draft", complete: false },
  ], false, 1_000)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Working draft grows", complete: false },
  ], false, 1_100)).toEqual([
    { kind: "commentary", text: "Working draft" },
  ]);
  expect(tracker.observe([
    { kind: "commentary", text: "Rewritten result", complete: false },
  ], false, 1_150)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Rewritten result", complete: false },
  ], false, 1_250)).toEqual([
    { kind: "commentary", text: "Rewritten result" },
  ]);
});

test("keeps animated status fragments behind the full stability window", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);

  expect(tracker.observe([{ kind: "status", text: "I" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "I am" }], false, 1_100)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "I am checking" }], false, 1_200)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "I am checking" }], false, 1_300)).toEqual([
    { kind: "reasoning", text: "I am checking" },
  ]);
});

test("records each browser latency stage once without logging response content", () => {
  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => { messages.push(String(message)); };
  try {
    const latency = new ChatGptTurnLatencyDiagnostics("trace-test", 1_000);
    latency.responseVisible(1_100);
    latency.observe([
      { kind: "status", text: "private status text" },
      { kind: "commentary", text: "private commentary text" },
    ], 1_200);
    latency.observe([{ kind: "commentary", text: "changed private text" }], 1_300);
    latency.commentaryEmitted(1_450);
    latency.commentaryEmitted(1_500);
  } finally {
    console.info = original;
  }
  expect(messages).toHaveLength(4);
  expect(messages.join("\n")).toContain("stage=response_visible elapsedMs=100");
  expect(messages.join("\n")).toContain("stage=web_first_status elapsedMs=200");
  expect(messages.join("\n")).toContain("stage=web_first_commentary elapsedMs=200");
  expect(messages.join("\n")).toContain("stage=adapter_first_commentary elapsedMs=450 stableMs=250");
  expect(messages.join("\n")).not.toContain("private");
});
