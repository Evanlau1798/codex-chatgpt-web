import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { decodeChatCompletion, parseChatCompletion } from "../src/chat-completions/contract";

test("atomic summaries accept a revised draft while ordinary streamed answers still reject changes", () => {
  const first = { key: "a", tag: "p", html: "<p>Earlier summary.</p>", text: "Earlier summary.", streamable: true };
  const second = { key: "b", tag: "p", html: "<p>Final detail.</p>", text: "Final detail.", streamable: true };
  const revised = { ...first, html: "<p>Corrected summary.</p>", text: "Corrected summary." };
  const summary = new ChatGptMarkdownBuffer(undefined, 0, "markdown", false);
  const answer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const draft of [[first, second], [first, second], [second, revised]]) {
    expect(summary.observe(draft)).toBe("");
    answer.observe(draft);
  }
  expect(summary.finish()).toEqual({
    markdown: "Final detail.\n\nCorrected summary.", delta: "Final detail.\n\nCorrected summary.",
  });
  expect(() => answer.finish()).toThrow("completed text block");
});

function katex(source: string, display = false): string {
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const math = '<span class="katex"><span class="katex-mathml"><math><semantics>'
    + '<mrow><mi>ACCESSIBLE_COPY</mi><mo>\u2061</mo></mrow>'
    + `<annotation encoding="application/x-tex">${escaped}</annotation>`
    + '</semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_COPY\u200b</span></span>';
  return display ? `<span class="katex-display">${math}</span>` : math;
}

test("KaTeX inline and display formulas preserve exactly one original LaTeX expression", () => {
  const inline = String.raw`E = mc^2`;
  const display = String.raw`r_{\mathrm{eff}} = \exp\left(-\sum_i q_i \log q_i\right)`;
  expect(chatGptHtmlToMarkdown(`<p>Inline: ${katex(inline)}.</p>${katex(display, true)}`)).toBe(
    `Inline: \\(${inline}\\).\n\n\\[\n${display}\n\\]`,
  );
});

test("math source survives lists, links, nested braces, Unicode, and wiki-shaped expressions", () => {
  const source = String.raw`\operatorname{rank}\left(\frac{α_{i}}{1+β}\right) < 2 \quad [[x]]`;
  expect(chatGptHtmlToMarkdown(
    `<ul><li>Value ${katex(source)}; <a href="https://example.com">reference</a>.</li></ul>`
      + '<p>Open [[Notes/math|notes]].</p>' + katex(`${source}\n+ γ`, true),
  )).toBe(`- Value \\(${source}\\); [reference](https://example.com).\n\n`
    + `Open [notes](<Notes/math.md>).\n\n\\[\n${source}\n+ γ\n\\]`);
  const code = String.raw`\frac{a_b}{c} [[literal]]`;
  expect(chatGptHtmlToMarkdown(`<p><code>${code}</code></p><pre><code>${code}</code></pre>`))
    .toBe(`\`${code}\`\n\n\`\`\`\n${code}\n\`\`\``);
});

test("LaTeX comment newlines survive generic HTML whitespace normalization", () => {
  const source = "a % comment\n+ b";
  expect(chatGptHtmlToMarkdown(katex(source, true))).toBe(`\\[\n${source}\n\\]`);
});

test("unknown or ambiguous KaTeX source fails instead of inventing a formula", () => {
  const formula = katex("x");
  expect(() => chatGptHtmlToMarkdown(formula.replace(/<annotation[^>]*>.*?<\/annotation>/, "")))
    .toThrow("one unambiguous LaTeX source");
  expect(() => chatGptHtmlToMarkdown(formula.replace("</semantics>",
    '<annotation encoding="application/x-tex">y</annotation></semantics>')))
    .toThrow("one unambiguous LaTeX source");
});

test("streaming formulas once still rejects a rewrite of committed math", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const segment = (source: string) => ({
    key: "formula", tag: "p", text: `ACCESSIBLE_COPY${source}VISUAL_COPY`,
    html: `<p>${katex(source)}</p>`, streamable: true,
  });
  expect(buffer.observe([segment("x_1")], 0)).toBe(String.raw`\(x_1\)`);
  expect(buffer.observe([segment("x_1")], 1)).toBe("");
  buffer.observe([segment("x_2")], 2);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

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
      observedTag: "p", committedTag: "p", observedIndex: 0, committedIndex: 0,
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


test("repeated report headings can first appear after an earlier copy was committed", () => {
  for (const { count, repeated, tag, text } of [
    { count: 93, repeated: [15, 20, 25, 29], tag: "p", text: "変更済み:" },
    { count: 199, repeated: [40, 83], tag: "h2", text: "Functions" },
  ]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    const report = Array.from({ length: count }, (_, index) => {
      const blockTag = repeated.includes(index) ? tag : "p";
      const value = repeated.includes(index) ? text : `Unique block ${index}`;
      return { key: `${index}:${blockTag}`, tag: blockTag, text: value,
        html: `<${blockTag}>${value}</${blockTag}>`, streamable: true };
    });
    for (let length = 2; length <= report.length; length += 1) {
      buffer.observe(report.slice(0, length).map((block, index) => ({
        ...block, streamable: index < length - 1,
      })), length);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
    }
    const expected = report.map(block => chatGptHtmlToMarkdown(block.html)).join("\n\n");
    expect(buffer.finish().markdown).toBe(expected);
    buffer.observe([report[0]!, report[0]!], count + 1);
    expect(() => buffer.finish()).toThrow("changed a completed text block");
  }
});
