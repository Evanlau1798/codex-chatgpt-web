import { describe, expect, test } from "bun:test";
import { ChatGptMarkdownOwnershipTracker } from "../src/adapters/chatgpt-web/markdown-ownership";
import { ChatGptVisibleTraceTracker } from "../src/adapters/chatgpt-web/visible-trace-tracker";

const root = (
  nodeId: string,
  ownership: "commentary" | "provisional" | "final",
  text: string,
  toolEpoch = 0,
) => ({
  nodeId,
  ownership,
  toolEpoch,
  text,
  html: `<p>${text}</p>`,
  segments: [{ key: "p", html: `<p>${text}</p>`, text, streamable: false }],
});

describe("ChatGPT Markdown phase ownership", () => {
  test("withholds provisional Markdown until the running turn completes", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();

    expect(tracker.observe([root("node-1", "provisional", "Work complete")])).toMatchObject({
      markdownSegments: [],
      commentaryBlocks: [],
    });
    expect(tracker.observe([]).markdownSegments).toEqual([]);

    const completed = tracker.observe([root("node-1", "final", "Work complete")]);
    expect(completed.markdownSegments.map(segment => segment.text)).toEqual(["Work complete"]);
  });

  test("keeps tool commentary out of the final stream after reparent and virtualization", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();

    expect(tracker.observe([root("node-1", "commentary", "Gathering evidence")])).toMatchObject({
      markdownSegments: [],
      commentaryBlocks: [{ kind: "commentary", text: "Gathering evidence" }],
    });

    const reparented = tracker.observe([
      root("node-1", "final", "Gathering evidence"),
      root("node-2", "final", "Review complete", 1),
    ]);
    expect(reparented.markdownSegments.map(segment => segment.text)).toEqual(["Review complete"]);
    expect(reparented.commentaryBlocks.map(block => block.text)).toEqual(["Gathering evidence"]);

    const virtualized = tracker.observe([root("node-2", "final", "Review complete", 1)]);
    expect(virtualized.markdownSegments.map(segment => segment.text)).toEqual(["Review complete"]);
    expect(virtualized.commentaryBlocks.map(block => block.text)).toEqual(["Gathering evidence"]);
  });

  test("recovers a replaced commentary node only inside the same tool epoch", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    tracker.observe([root("node-1", "commentary", "Checking tests", 3)]);

    const replaced = tracker.observe([root("node-replaced", "final", "Checking tests", 3)]);
    expect(replaced.markdownSegments).toEqual([]);
    expect(replaced.commentaryBlocks.map(block => block.text)).toEqual(["Checking tests"]);

    const identicalFinal = tracker.observe([root("node-final", "final", "Checking tests", 4)]);
    expect(identicalFinal.markdownSegments.map(segment => segment.text)).toEqual(["Checking tests"]);
  });

  test("keeps append-only commentary growth on a replaced React node", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    tracker.observe([root("node-1", "commentary", "第一個唯讀", 2)]);

    const growing = tracker.observe([root("node-2", "commentary", "第一個唯讀記憶查詢", 2)]);
    expect(growing.commentaryBlocks.map(block => block.text)).toEqual(["第一個唯讀記憶查詢"]);
  });

  test("keeps append-only commentary identity when the global tool epoch advances", () => {
    const ownership = new ChatGptMarkdownOwnershipTracker();
    const trace = new ChatGptVisibleTraceTracker(0);

    const prefix = ownership.observe([root("node-1", "commentary", "這是現", 2)]);
    expect(trace.observe(prefix.commentaryBlocks, false)).toEqual([
      { kind: "commentary", text: "這是現" },
    ]);

    const growing = ownership.observe([
      root("node-2", "commentary", "這是現有 repository / runtime 的診斷工作", 3),
    ]);
    expect(trace.observe(growing.commentaryBlocks, false)).toEqual([{
      kind: "commentary",
      text: "有 repository / runtime 的診斷工作",
      continuation: true,
    }]);
  });

  test("keeps commentary identity when an unchanged React node remount crosses tool epochs", () => {
    const ownership = new ChatGptMarkdownOwnershipTracker();
    const trace = new ChatGptVisibleTraceTracker(0);

    const prefix = ownership.observe([root("node-1", "commentary", "兩個 session", 2)]);
    expect(trace.observe(prefix.commentaryBlocks, false)).toEqual([
      { kind: "commentary", text: "兩個 session" },
    ]);

    const remounted = ownership.observe([root("node-2", "commentary", "兩個 session", 3)]);
    expect(trace.observe(remounted.commentaryBlocks, false)).toEqual([]);

    const growing = ownership.observe([
      root("node-2", "commentary", "兩個 session 檔都已定位", 3),
    ]);
    expect(trace.observe(growing.commentaryBlocks, false)).toEqual([{
      kind: "commentary",
      text: " 檔都已定位",
      continuation: true,
    }]);
  });

  test("keeps growing commentary owned after a replaced node is reclassified as final", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    tracker.observe([root("node-1", "commentary", "Reviewing **147 files, about +", 2)]);
    const completed = root("node-2", "final", "Reviewing 147 files, about +12.8k lines", 2);
    completed.html = "<p>Reviewing <strong>147 files, about +12.8k lines</strong></p>";
    completed.segments = [{
      key: "p",
      html: completed.html,
      text: completed.text,
      streamable: false,
    }];

    const reclassified = tracker.observe([completed]);
    expect(reclassified.markdownSegments).toEqual([]);
    expect(reclassified.commentaryBlocks.map(block => block.text)).toEqual([
      "Reviewing **147 files, about +12.8k lines**",
    ]);
  });

  test("reconnects commentary after one empty DOM observation without replaying its prefix", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    tracker.observe([root("node-1", "commentary", "正在檢查", 5)]);
    expect(tracker.observe([]).commentaryBlocks).toEqual([
      expect.objectContaining({ text: "正在檢查", complete: true }),
    ]);

    const resumed = tracker.observe([root("node-2", "commentary", "正在檢查測試", 5)]);
    expect(resumed.commentaryBlocks).toEqual([
      expect.objectContaining({ text: "正在檢查測試" }),
    ]);
  });

  test("reconnects a replaced commentary node that remounts from a shorter prefix", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    tracker.observe([root("node-1", "commentary", "ROUND_2_START\n\n上一輪已完成", 5)]);
    tracker.observe([]);

    expect(tracker.observe([root("node-2", "commentary", "ROUND_2_START", 5)])
      .commentaryBlocks.map(block => block.text)).toEqual(["ROUND\\_2\\_START"]);
    expect(tracker.observe([root("node-2", "commentary", "ROUND_2_START\n\n上一輪已完成新的範圍", 5)])
      .commentaryBlocks.map(block => block.text)).toEqual(["ROUND\\_2\\_START 上一輪已完成新的範圍"]);
  });

  test("coalesces simultaneous append-only commentary roots into the longest version", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    const observed = tracker.observe([
      root("node-1", "commentary", "Reading package", 6),
      root("node-2", "commentary", "Reading package metadata", 6),
    ]);

    expect(observed.commentaryBlocks.map(block => block.text)).toEqual(["Reading package metadata"]);
  });

  test("returns commentary through the shared HTML-to-Markdown conversion", () => {
    const tracker = new ChatGptMarkdownOwnershipTracker();
    const markdownRoot = root("node-1", "commentary", "SMOKE_PROGRESS", 7);
    markdownRoot.html = "<p><strong>SMOKE_PROGRESS</strong></p>";
    markdownRoot.segments = [{
      key: "p",
      html: markdownRoot.html,
      text: markdownRoot.text,
      streamable: false,
    }];

    expect(tracker.observe([markdownRoot]).commentaryBlocks.map(block => block.text))
      .toEqual(["**SMOKE\\_PROGRESS**"]);
  });
});
