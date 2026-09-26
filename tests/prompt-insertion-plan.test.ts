import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { guardChatGptPromptMarkdown } from "../src/adapters/chatgpt-web/prompt-caret";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import {
  chatGptPromptInsertChunkEnd,
  chatGptPromptPreservesLeading,
  planChatGptPromptInsertion,
} from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { composerSyntheticFixtures } from "./fixtures/composer-synthetic";

function split(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = chatGptPromptInsertChunkEnd(text, offset);
    assert.ok(end > offset && end - offset <= 16_000);
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    assert.ok(!(previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF));
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

for (const fixture of composerSyntheticFixtures()) {
  test(`synthetic ${fixture.id}: shape and lossless chunk boundaries`, () => {
    const plan = planChatGptPromptInsertion(fixture.text);
    const lines = fixture.text.split(/\r\n|[\r\n\u2028\u2029]/u);
    assert.equal(plan.strategy, "guarded-chunked");
    assert.equal(plan.utf16Units, fixture.text.length);
    assert.equal(plan.lineCount, lines.length);
    assert.equal(plan.maxLineUnits, Math.max(...lines.map(line => line.length)));
    assert.equal(plan.hasCR, fixture.text.includes("\r"));
    assert.equal(plan.hasNul, fixture.text.includes("\u0000"));
    const guarded = guardChatGptPromptMarkdown(fixture.text);
    assert.equal(plan.markdownDelimiterCount, guarded?.count ?? 0);
    assert.equal(split(fixture.text).join(""), fixture.text);
    if (guarded) {
      assert.equal(split(guarded.text).join(""), guarded.text);
      let restored = guarded.text;
      for (const replacement of guarded.replacements) {
        assert.equal(fixture.text.includes(replacement.marker), false);
        restored = restored.replaceAll(replacement.marker, replacement.value);
      }
      assert.equal(restored, fixture.text);
    }
  });

  test(`synthetic ${fixture.id}: production direct writer keeps the existing edit route`, async () => {
    // This is an action-recording locator, not a browser or a readback correctness oracle.
    const edits: unknown[] = [];
    const verified: string[] = [];
    let anchors = 0;
    const composer = {
      focus: async () => {},
      evaluate: async (_operation: unknown, value: unknown) => { edits.push(value); return true; },
    } as unknown as Locator;
    await insertChatGptPromptText(fixture.text, undefined, {
      composer: async () => composer,
      verify: async expected => { verified.push(expected); },
      reanchor: async () => { anchors += 1; },
    }, { forceStructuredDirect: true });
    const html = fixture.text.length > 32_000 && !/[\r\n\u2028\u2029\u0000]/u.test(fixture.text);
    assert.equal(edits.length, 1);
    const edit = edits[0];
    assert.equal(typeof edit === "object", html);
    assert.equal((typeof edit === "object" ? (edit as { text: string }).text : edit) === fixture.text, true);
    if (html) assert.equal((edit as { prewrap?: boolean }).prewrap, undefined);
    const expected = chatGptPromptPreservesLeading(planChatGptPromptInsertion(fixture.text, { forceStructuredDirect: true }))
      ? fixture.text : fixture.text.trimStart();
    assert.equal(verified.length, 3);
    assert.equal(verified[0], "");
    assert.equal(verified[1] === expected && verified[2] === expected, true);
    assert.equal(anchors, 1);
  });
}

for (const length of [15_999, 16_000, 16_001, 31_999, 32_000, 32_001]) {
  test(`direct opt-in preserves the strict threshold at ${length}`, () => {
    const text = "x".repeat(length);
    assert.equal(planChatGptPromptInsertion(text).strategy, "guarded-chunked");
    assert.equal(planChatGptPromptInsertion(text, { largeStructuredDirect: true }).strategy,
      length > 32_000 ? "direct-html" : "guarded-chunked");
    assert.equal(planChatGptPromptInsertion(text, { forceStructuredDirect: true }).strategy,
      length > 32_000 ? "direct-html" : "direct-text");
  });
}

test("large multiline direct prompts use the exact native text path", () => {
  const text = `${"x".repeat(40_000)}\nlast line`;
  assert.equal(planChatGptPromptInsertion(text, { largeStructuredDirect: true }).strategy, "direct-text");
  assert.equal(planChatGptPromptInsertion(text, { candidatePlainText: true }).strategy, "direct-text");
  assert.equal(planChatGptPromptInsertion("x".repeat(40_000), { largeStructuredDirect: true }).strategy, "direct-html");
});

test("large multiline direct prompts keep native line breaks on the updated composer", () => {
  const text = `Header\n${"body `code` *bold* ".repeat(5_000)}\nEnd`;
  assert.equal(planChatGptPromptInsertion(text, { largeStructuredDirect: true }).strategy, "direct-text");
  assert.equal(planChatGptPromptInsertion(text, { forceStructuredDirect: true }).strategy, "direct-text");
});

test("actual CR and NUL keep direct-text; their literal escapes do not", () => {
  const base = "x".repeat(32_001);
  for (const control of ["\r", "\r\n", "\u0000"]) {
    assert.equal(planChatGptPromptInsertion(base + control, { largeStructuredDirect: true }).strategy, "direct-text");
  }
  for (const literal of ["\\r", "\\r\\n", "\\u0000"]) {
    assert.equal(planChatGptPromptInsertion(base + literal, { largeStructuredDirect: true }).strategy, "direct-html");
  }
});

test("a lone surrogate never enters HTML parsing", () => {
  const text = `${"x".repeat(40_000)}\n\uD800`;
  assert.equal(planChatGptPromptInsertion(text, { largeStructuredDirect: true }).strategy, "direct-text");
  assert.equal(planChatGptPromptInsertion(`${"x".repeat(40_000)}\n😀`, { largeStructuredDirect: true }).strategy,
    "direct-text");
});

test("shape facts do not retain content and distinguish delimiters from private-use markers", () => {
  const plan = planChatGptPromptInsertion("secret-fixture\r\n\uE000\uF8FF`*_~=[)\u0000\u2028😀\u2029");
  assert.equal(plan.markdownDelimiterCount, 7);
  assert.equal(plan.lineCount, 4);
  assert.equal(plan.maxLineUnits, 14);
  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(Object.keys(plan).sort(), [
    "strategy", "utf16Units", "lineCount", "maxLineUnits", "markdownDelimiterCount", "hasCR", "hasNul",
  ].sort());
  assert.equal(JSON.stringify(plan).includes("secret-fixture"), false);
});

test("empty input and invalid chunk offsets are explicit", () => {
  assert.deepEqual(planChatGptPromptInsertion(""), {
    strategy: "guarded-chunked", utf16Units: 0, lineCount: 1, maxLineUnits: 0,
    markdownDelimiterCount: 0, hasCR: false, hasNul: false,
  });
  for (const offset of [-1, 1.5, NaN, Infinity, 1]) {
    assert.throws(() => chatGptPromptInsertChunkEnd("x", offset), RangeError);
  }
  assert.throws(() => chatGptPromptInsertChunkEnd("", 0), RangeError);
});

test("whitespace lookback means ceil(length / 16000) is not the actual chunk count", () => {
  const text = ("x".repeat(11_999) + " ").repeat(4);
  const chunks = split(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > Math.ceil(text.length / 16_000));
});

test("a surrogate pair on the hard boundary stays in the same chunk", () => {
  const text = "x".repeat(15_999) + "😀" + "y".repeat(100);
  const chunks = split(text);
  assert.equal(chunks[0]!.length, 15_999);
  assert.equal(chunks[1]!.startsWith("😀"), true);
});

test("production default writer still inserts multiple chunks without a direct opt-in", async () => {
  const text = "x".repeat(32_001);
  const edits: unknown[] = [];
  const verified: number[] = [];
  const composer = {
    focus: async () => {},
    evaluate: async (_operation: unknown, value: unknown) => { edits.push(value); return true; },
  } as unknown as Locator;
  await insertChatGptPromptText(text, undefined, {
    composer: async () => composer,
    verify: async expected => { assert.equal(expected, text.slice(0, expected.length)); verified.push(expected.length); },
    reanchor: async () => {},
  });
  assert.deepEqual(edits, ["x".repeat(16_000), "x".repeat(16_000), "x"]);
  assert.deepEqual(verified, [16_000, 32_000, 32_001]);
});

test("fixture reconstruction is deterministic and large cases have the advertised size", () => {
  const fixtures = composerSyntheticFixtures();
  assert.deepEqual(fixtures, composerSyntheticFixtures());
  assert.equal(fixtures.length, 12);
  assert.equal(fixtures.find(f => f.id === "c02")!.text.length, 89_000);
  assert.equal(fixtures.find(f => f.id === "c03")!.text.length, 330_000);
});
