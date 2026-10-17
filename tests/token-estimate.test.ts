import { expect, test } from "bun:test";
import { estimateTokens } from "../src/lib/token-estimate";

test("counts GPT-5 text with the o200k tokenizer", () => {
  expect(estimateTokens("hello world")).toBe(2);
});

test("dense encoded context is not under-counted as prose", () => {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(300_000);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  const encoded = bytes.toString("base64");

  expect(encoded.length).toBe(400_000);
  expect(estimateTokens(encoded)).toBeGreaterThan(256_000);
});

test("pathological repeated text is counted in bounded chunks", () => {
  expect(estimateTokens("a".repeat(32_768))).toBe(4_096);
});

test("repeated chunks keep exact counts across changes, partial tails and Unicode boundaries", () => {
  const a = "a".repeat(4096);
  const b = "b".repeat(4096);
  expect(estimateTokens(a + a + b + b + "hello world"))
    .toBe(2 * estimateTokens(a) + 2 * estimateTokens(b) + 2);
  const unicode = "a".repeat(4095) + "😀";
  expect(estimateTokens(unicode.repeat(2)))
    .toBe(estimateTokens("a".repeat(4095)) + estimateTokens("😀" + "a".repeat(4094)) + estimateTokens("a😀"));
  expect(estimateTokens("hello world")).toBe(2);
  expect(estimateTokens("")).toBe(0);
});

test("large ordinary prose is not inflated by a character-ratio heuristic", () => {
  const prose = `${"word ".repeat(97_999)}word`;
  expect(prose.length).toBe(489_999);
  expect(estimateTokens(prose)).toBeLessThan(100_000);
});
