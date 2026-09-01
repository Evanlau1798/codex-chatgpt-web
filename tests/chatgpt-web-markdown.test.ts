import { expect, test } from "bun:test";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    ["output/path-format-probe/alpha-notes.md", "output/path-format-probe/alpha-notes.md"],
    ["/Users/dev/project/src/gamma-helper.ts", "/Users/dev/project/src/gamma-helper.ts"],
    [String.raw`C:\Users\Dev\project\zeta-result.pdf`, "C:/Users/Dev/project/zeta-result.pdf"],
    ["src/adapters/chatgpt-web/markdown.ts:47:3", "src/adapters/chatgpt-web/markdown.ts:47:3"],
  ];
  for (const [path, target] of cases) {
    expect(chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`))
      .toBe(`Created [${path}](<${target}>).`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "<code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");
  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, retain `turn/diff/updated`, `https://example.com/report.pdf`, `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});
