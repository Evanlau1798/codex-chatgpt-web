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
  ], false, 1_300));

  expect(output).toEqual([
    { kind: "commentary", text: "Cod" },
    { kind: "commentary", text: "ex Native", continuation: true },
    { kind: "commentary", text: " 正在讀取 `repo`", continuation: true },
  ]);
  expect(output.map(event => event.text).join("")).toBe("Codex Native 正在讀取 `repo`");
});

test("does not replay a non-prefix commentary rewrite after output was committed", () => {
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
  ], false, 1_250)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Working draft safely grows", complete: false },
  ], false, 1_300)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Working draft safely grows", complete: false },
  ], false, 1_400)).toEqual([{
    kind: "commentary",
    text: " safely grows",
    continuation: true,
  }]);
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

test("uses the Markdown buffer stability window before first commentary output", () => {
  const tracker = new ChatGptVisibleTraceTracker();
  const commentary = [{ kind: "commentary" as const, text: "正在檢查目前狀態" }];

  expect(tracker.observe(commentary, false, 1_000)).toEqual([]);
  expect(tracker.observe(commentary, false, 1_250)).toEqual([]);
  expect(tracker.observe(commentary, false, 1_750)).toEqual([{
    kind: "commentary",
    text: "正在檢查目前狀態",
  }]);
});

test("preserves commentary root boundaries without interleaving animated reasoning", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const blocks = [
    { kind: "status" as const, text: "正在思考" },
    { kind: "commentary" as const, key: "first", text: "目前 live Git 與", complete: true },
    { kind: "commentary" as const, key: "second", text: "舊 handoff 有差異" },
  ];

  expect(tracker.observe(blocks, false, 1_000)).toEqual([]);
  expect(tracker.observe(blocks, false, 1_100)).toEqual([
    { kind: "reasoning", text: "正在思考" },
    { kind: "commentary", text: "目前 live Git 與" },
    { kind: "commentary", text: "舊 handoff 有差異" },
  ]);

  const growing = [
    { kind: "status" as const, text: "讀取記憶與部署摘要" },
    { kind: "commentary" as const, key: "first", text: "目前 live Git 與", complete: true },
    { kind: "commentary" as const, key: "second", text: "舊 handoff 有差異，正在重新驗證" },
  ];
  expect(tracker.observe(growing, false, 1_200)).toEqual([]);
  expect(tracker.observe(growing, false, 1_300)).toEqual([{
    kind: "commentary",
    text: "，正在重新驗證",
    continuation: true,
  }]);
});

test("does not replay a completed commentary root while its React replacement grows", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const output = [];

  output.push(...tracker.observe([
    { kind: "commentary", key: "root", text: "Repository read-only guidance" },
  ], false, 1_000));
  output.push(...tracker.observe([
    { kind: "commentary", key: "root", text: "Repository read-only guidance stays scoped" },
  ], false, 1_100));
  output.push(...tracker.observe([
    { kind: "commentary", key: "root", text: "Repository read-only guidance stays scoped to tests" },
  ], false, 1_200));
  output.push(...tracker.observe([
    { kind: "commentary", key: "root", text: "Repository read-only guidance stays scoped to tests", complete: true },
  ], false, 1_300));

  expect(output.map(event => event.text).join("")).toBe(
    "Repository read-only guidance stays scoped to tests",
  );
});

test("does not replay a later commentary root when earlier roots become complete", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const output = [];
  const bothIncomplete = [
    { kind: "commentary" as const, key: "first", text: "First root:", complete: false },
    { kind: "commentary" as const, key: "second", text: "second root", complete: false },
  ];

  output.push(...tracker.observe(bothIncomplete, false, 1_000));
  output.push(...tracker.observe(bothIncomplete, false, 1_100));
  output.push(...tracker.observe([
    { ...bothIncomplete[0], complete: true },
    bothIncomplete[1],
  ], false, 1_200));
  output.push(...tracker.observe([
    { ...bothIncomplete[0], complete: true },
    bothIncomplete[1],
  ], false, 1_300));

  expect(output).toEqual([
    { kind: "commentary", text: "First root:" },
    { kind: "commentary", text: "second root" },
  ]);
});

test("waits out escaped raw Markdown until the renderer exposes stable Markdown", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const raw = [{ kind: "commentary" as const, text: "I am starting \\*\\*SMOKE_PROGRESS" }];
  const rendered = [{ kind: "commentary" as const, text: "I am starting **SMOKE_PROGRESS**" }];

  expect(tracker.observe(raw, false, 1_000)).toEqual([]);
  expect(tracker.observe(raw, false, 1_100)).toEqual([]);
  expect(tracker.observe(rendered, false, 1_101)).toEqual([]);
  expect(tracker.observe(rendered, false, 1_201)).toEqual([{
    kind: "commentary",
    text: "I am starting **SMOKE_PROGRESS**",
  }]);
});

test("does not commit escaped incomplete Markdown before the renderer settles", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const raw = [{ kind: "commentary" as const, text: "Reviewing \\*\\*147 files, about +" }];
  const rendered = [{ kind: "commentary" as const, text: "Reviewing **147 files, about +12.8k lines**" }];

  expect(tracker.observe(raw, false, 1_000)).toEqual([]);
  expect(tracker.observe(raw, false, 1_200)).toEqual([]);
  expect(tracker.observe(raw, false, 2_000)).toEqual([]);
  expect(tracker.observe(rendered, false, 2_001)).toEqual([]);
  expect(tracker.observe(rendered, false, 2_101)).toEqual([{
    kind: "commentary",
    text: "Reviewing **147 files, about +12.8k lines**",
  }]);
});

test("streams a stable escaped prefix while its raw Markdown tail keeps growing", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);

  expect(tracker.observe([{ kind: "commentary", text: "Reviewing \\*one" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "commentary", text: "Reviewing \\*one and two" }], false, 1_100)).toEqual([]);
  expect(tracker.observe([{ kind: "commentary", text: "Reviewing \\*one and two and three" }], false, 1_200)).toEqual([{
    kind: "commentary",
    text: "Reviewing \\*one",
  }]);
});

test("streams stable commentary containing escaped filename punctuation", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const commentary = [{ kind: "commentary" as const, text: "正在讀取 `browser\\_worker.ts`" }];

  expect(tracker.observe(commentary, false, 1_000)).toEqual([]);
  expect(tracker.observe(commentary, false, 1_100)).toEqual([{
    kind: "commentary",
    text: "正在讀取 `browser\\_worker.ts`",
  }]);
});

test("streams a stable rendered prefix while the growing tail still contains raw Markdown", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);

  expect(tracker.observe([
    { kind: "commentary", text: "已完成第一段" },
  ], false, 1_000)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "已完成第一段 \\*\\*正在補上第二段" },
  ], false, 1_100)).toEqual([{
    kind: "commentary",
    text: "已完成第一段",
  }]);
  expect(tracker.observe([
    { kind: "commentary", text: "已完成第一段 **正在補上第二段**" },
  ], false, 1_200)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "已完成第一段 **正在補上第二段**" },
  ], false, 1_300)).toEqual([{
    kind: "commentary",
    text: " **正在補上第二段**",
    continuation: true,
  }]);
});

test("does not treat a transient tool-adjacent status as a commentary flush boundary", () => {
  const tracker = new ChatGptVisibleTraceTracker(10_000);
  const blocks = [
    { kind: "commentary" as const, text: "正在確認", complete: true },
    { kind: "status" as const, text: "Called Codex Native2" },
  ];

  expect(tracker.observe(blocks, false, 1_000)).toEqual([]);
  expect(tracker.observe(blocks, true, 1_001)).toEqual([
    { kind: "reasoning", text: "Called Codex Native2" },
    { kind: "commentary", text: "正在確認" },
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
