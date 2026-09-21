/** Synthetic-only cases adapted from composer-fixture-staging.zip. No transcript or captured DOM. */
export interface ComposerSyntheticFixture {
  id: string;
  name: string;
  text: string;
  mutations: string[];
}

export function composerSyntheticFixtures(): ComposerSyntheticFixture[] {
  const seed = 430033;
  let state = seed;
  function next(): number { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }
  const record = (role: string, content: unknown) => JSON.stringify({ role, content });
  const fakeConversation = [
    record("system", "Fixture rules: keep exact text; no external action."),
    record("developer", "Use C:\\fixture\\workspace and https://example.invalid/item only as inert data."),
    record("user", "Paragraph one.\n\n  Paragraph two  with  spaces.\n```json\n{\"path\":\"C:\\\\fixture\\\\item\",\"v\":\"\\n\"}\n```"),
    record("assistant", [{ type: "tool_call", id: "call_001", name: "fixture.lookup", arguments: "{\"key\":\"item_001\"}" }]),
    record("tool", { call_id: "call_001", result: { id: "item_001", note: "synthetic result", rows: [1, 2] } }),
    record("assistant", "Fixture response.\n\n<summary>safe checkpoint</summary>"),
    record("compaction", "Summary of synthetic turns: preserve call_001 and item_001."),
    record("user", "Continue the fixture only. & < > </item>\n\nEnd."),
  ].join("\n");
  const denseRow = '`code` **bold** ~~strike~~ [link](https://example.invalid) {"quote":"\\\"","slash":"\\\\"} <item> & </item>\n';
  function sized(target: number, unit: string): string {
    let out = fakeConversation + "\n";
    while (out.length + unit.length <= target) out += unit;
    return out + "xyz"[next() % 3]!.repeat(target - out.length);
  }
  function boundary(n: number): string {
    const left = "x".repeat(n - 3);
    return left + " 😀\n" + "tail";
  }
  return [
    { id: "c01", name: "synthetic-baseline", text: fakeConversation, mutations: [] },
    { id: "c02", name: "compaction-shape-89k", text: sized(89_000, fakeConversation + "\n"), mutations: ["synthetic-repeat-to-89000"] },
    { id: "c03", name: "dense-markdown-330k", text: sized(330_000, denseRow), mutations: ["synthetic-dense-markdown-to-330000"] },
    ...[15999, 16000, 16001, 31999, 32000, 32001].map((n, i) => ({
      id: `c${String(i + 4).padStart(2, "0")}`, name: `boundary-${n}`, text: boundary(n), mutations: [`boundary-parameter-${n}`],
    })),
    { id: "c10", name: "control-escapes", text: "LF\nCR\rCRLF\r\n\\n \\r NUL\u0000 \\u0000\n\n \n\t  \u00a0\n\n</item>\n\n", mutations: ["controls-and-wire-escapes"] },
    { id: "c11", name: "unicode-markers", text: "\u2028\u2029\uFEFF\u200B\u2060\uE000\uF8FF😀👩‍💻 e\u0301 é\n" + "L".repeat(16_010) + " 😀" + Array.from({ length: 100 }, (_, i) => `\n${i}`).join(""), mutations: ["unicode-and-line-distribution"] },
    { id: "c12", name: "synthetic-dom", text: "alpha\n beta\n\ngamma\n\ndelta", mutations: ["inline-siblings", "nested-br", "empty-block", "ui-pill", "cursor-target", "root-remount"] },
  ];
}
