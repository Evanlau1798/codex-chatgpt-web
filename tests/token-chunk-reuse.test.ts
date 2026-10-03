import { expect, test } from "bun:test";
import { get_encoding } from "tiktoken";
import { estimateTokens } from "../src/lib/token-estimate";

test("chunk reuse preserves exact independent counts including surrogate boundaries and cache capacity", () => {
  const encoding = get_encoding("o200k_base");
  try {
    for (const text of ["word ".repeat(12000), " ".repeat(9000), "x".repeat(4095) + "😀".repeat(3000),
      Array.from({ length: 270 }, (_, i) => String(i).padEnd(4096, "x")).join("")]) {
      let expected = 0;
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 4096, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
        expected += encoding.encode_ordinary(text.slice(start, end)).length;
        start = end;
      }
      expect(estimateTokens(text)).toBe(expected);
    }
  } finally { encoding.free(); }
}, 60000);
