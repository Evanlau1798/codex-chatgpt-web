import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { decodeChatCompletion, parseChatCompletion } from "../src/chat-completions/contract";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    { path: "/Users/dev/project/src/gamma-helper.ts", target: "/Users/dev/project/src/gamma-helper.ts" },
    { path: String.raw`C:\Users\Dev\project\zeta-result.pdf`, target: "C:/Users/Dev/project/zeta-result.pdf" },
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown))
      .toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
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

test("Markdown conflicts expose only bounded structural diagnostics", () => {
  const buffer = new ChatGptMarkdownBuffer(value => value, 0);
  const segment = (text: string) => ({
    key: "0:p", tag: "p", html: `<p>${text}</p>`, text,
    sourceStart: 0, sourceEnd: 6, streamable: true,
  });
  buffer.observe([segment("Stable")], 0);
  buffer.observe([segment("Changed")], 1);
  try {
    buffer.finish();
    throw new Error("Expected a Markdown consistency error");
  } catch (error) {
    const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
    expect(diagnostic).toEqual({
      reason: "text_changed", observedStart: 0, observedEnd: 6,
      committedStart: 0, committedEnd: 6, observedTextChars: 7, committedTextChars: 6,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/Stable|Changed|<p/);
  }
});

test("previewing final Markdown does not commit pending output", () => {
  const buffer = new ChatGptMarkdownBuffer(value => value, 1_000);
  buffer.observe([{ key: "answer", html: "<p>Final answer.</p>", text: "Final answer.", streamable: false }], 0);
  expect(buffer.preview()).toBe("Final answer.");
  expect(buffer.preview()).toBe("Final answer.");
  expect(buffer.finish()).toEqual({ markdown: "Final answer.", delta: "Final answer." });
});

test("structured browser output preserves JSON escapes before tool decoding", () => {
  const input = parseChatCompletion({ model: "chatgpt-web/high", messages: [{ role: "user", content: "fixture" }],
    tools: [{ type: "function", function: { name: "write", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } }] });
  const content = 'first\nsecond\\n C:\\work\\file "quoted" _[brackets] 漢字';
  const raw = JSON.stringify({ content: null, tool_calls: [{ name: "write", arguments: { content } }] });
  const buffer = new ChatGptMarkdownBuffer(undefined, 0, "visible-text");
  buffer.observe([{ key: "json", tag: "p", html: `<p>${raw}</p>`, text: raw, streamable: false }]);
  const answer = buffer.finish().markdown;
  expect(answer).toBe(raw);
  expect(JSON.parse(decodeChatCompletion(input, answer).tool_calls![0]!.function.arguments)).toEqual({ content });
});

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});
