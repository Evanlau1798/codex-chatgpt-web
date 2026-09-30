import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHATGPT_LITERAL_PASTE_CHUNK_CHARS, chatGptPromptInsertChunkEnd, chatGptPromptPreservesLeading, planChatGptPromptInsertion,
} from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { composerSyntheticFixtures } from "./fixtures/composer-synthetic";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

function split(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = chatGptPromptInsertChunkEnd(text, offset);
    assert.ok(end > offset && end - offset <= CHATGPT_LITERAL_PASTE_CHUNK_CHARS);
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    assert.ok(!(previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF));
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

// Retired guard/replacement-alphabet roundtrips and 32K direct-HTML thresholds.
// Shape facts and lossless splitting remain; production DOM readback replaces
// guarded-string restoration and proves the same literals never take an HTML route.
for (const fixture of composerSyntheticFixtures()) {
  test(`synthetic ${fixture.id}: shape facts and lossless chunk boundaries`, () => {
    const plan = planChatGptPromptInsertion(fixture.text);
    const lines = fixture.text.split(/\r\n|[\r\n\u2028\u2029]/u);
    assert.equal(plan.strategy, "literal-paste");
    assert.equal(plan.utf16Units, fixture.text.length);
    assert.equal(plan.lineCount, lines.length);
    assert.equal(plan.maxLineUnits, Math.max(...lines.map(line => line.length)));
    assert.equal(plan.hasCR, fixture.text.includes("\r"));
    assert.equal(plan.hasNul, fixture.text.includes("\u0000"));
    assert.equal(plan.markdownDelimiterCount, [...fixture.text].filter(unit => "`*_~=[)".includes(unit)).length);
    assert.equal(split(fixture.text).join(""), fixture.text);
  });

  test(`synthetic ${fixture.id}: production writer verifies every exact literal prefix`, async () => {
    const editor = literalPasteComposer();
    await editor.run(fixture.text, { options: { forceStructuredDirect: true } });
    const chunks = split(fixture.text);
    assert.deepEqual(editor.pastes, chunks);
    assert.equal(editor.read(), fixture.text);
    assert.deepEqual(editor.verified, ["", ...chunks.map((_, i) => chunks.slice(0, i + 1).join("")), fixture.text]);
    assert.equal(editor.reanchors, 1);
  });
}

for (const length of [CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1, CHATGPT_LITERAL_PASTE_CHUNK_CHARS,
  CHATGPT_LITERAL_PASTE_CHUNK_CHARS + 1, CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 - 1,
  CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2, CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1]) {
  test(`legacy insertion flags cannot change strategy or leading preservation at ${length}`, () => {
    const text = " ".repeat(2) + "x".repeat(length - 2);
    const expected = planChatGptPromptInsertion(text);
    for (const options of [undefined, {}, { largeStructuredDirect: true }, { forceStructuredDirect: true },
      { candidatePlainText: true }, { largeStructuredDirect: true, forceStructuredDirect: true, candidatePlainText: true }]) {
      const plan = planChatGptPromptInsertion(text, options);
      assert.deepEqual(plan, expected);
      assert.equal(chatGptPromptPreservesLeading(plan), true);
    }
  });
}

test("multiline Markdown, CR/NUL and their literal escapes all use the same strategy", () => {
  const base = "x".repeat(40_000);
  for (const suffix of ["\nlast line", "\n`code` *bold*\n", "\r", "\r\n", "\u0000", "\\r", "\\r\\n", "\\u0000"]) {
    const plan = planChatGptPromptInsertion(base + suffix, { largeStructuredDirect: true });
    assert.equal(plan.strategy, "literal-paste");
    assert.equal(plan.hasCR, suffix.includes("\r"));
    assert.equal(plan.hasNul, suffix.includes("\0"));
  }
});

test("lone surrogates and surrogate pairs never enter HTML parsing", async () => {
  for (const suffix of ["\uD800", "\uDC00", "😀"]) {
    const prompt = "x".repeat(40_000) + "\n" + suffix;
    const editor = literalPasteComposer();
    await editor.run(prompt);
    assert.equal(editor.read(), prompt);
    assert.equal(editor.pastes.join(""), prompt);
  }
});

test("shape facts do not retain content and distinguish delimiters from private-use text", () => {
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

test("empty input and invalid chunk offsets are explicit", async () => {
  assert.deepEqual(planChatGptPromptInsertion(""), {
    strategy: "literal-paste", utf16Units: 0, lineCount: 1, maxLineUnits: 0,
    markdownDelimiterCount: 0, hasCR: false, hasNul: false,
  });
  for (const offset of [-1, 1.5, NaN, Infinity, 1]) {
    assert.throws(() => chatGptPromptInsertChunkEnd("x", offset), RangeError);
  }
  assert.throws(() => chatGptPromptInsertChunkEnd("", 0), RangeError);
  const editor = literalPasteComposer();
  await editor.run("");
  assert.deepEqual(editor.pastes, []);
  assert.deepEqual(editor.verified, ["", ""]);
});

test("whitespace lookback means ceil(length / native paste bound) is not the actual chunk count", () => {
  const text = ("x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 4_096) + " ").repeat(32);
  const chunks = split(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > Math.ceil(text.length / CHATGPT_LITERAL_PASTE_CHUNK_CHARS));
});

test("a surrogate pair on the hard boundary stays in the same chunk", () => {
  const text = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1) + "😀" + "y".repeat(100);
  const chunks = split(text);
  assert.equal(chunks[0]!.length, CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1);
  assert.equal(chunks[1]!.startsWith("😀"), true);
});

test("all legacy options still use multiple bounded transactions for an oversized prompt", async () => {
  const text = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1);
  for (const options of [undefined, { forceStructuredDirect: true }, { candidatePlainText: true }, { largeStructuredDirect: true }]) {
    const editor = literalPasteComposer();
    await editor.run(text, { options });
    assert.deepEqual(editor.pastes, ["x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS), "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS), "x"]);
    assert.deepEqual(editor.verified.map(value => value.length), [0, CHATGPT_LITERAL_PASTE_CHUNK_CHARS,
      CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2, text.length, text.length]);
  }
});

test("fixture reconstruction is deterministic and large cases have the advertised size", () => {
  const fixtures = composerSyntheticFixtures();
  assert.deepEqual(fixtures, composerSyntheticFixtures());
  assert.equal(fixtures.length, 12);
  assert.equal(fixtures.find(f => f.id === "c02")!.text.length, 89_000);
  assert.equal(fixtures.find(f => f.id === "c03")!.text.length, 330_000);
});
