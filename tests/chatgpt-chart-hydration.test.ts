import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("embedded chart hydration cannot replace Markdown answer content with renderer UI", () => {
  const { createDocument, createWindow } = require("@mixmark-io/domino") as {
    createDocument(html: string): { body: HTMLElement };
    createWindow(): { HTMLElement: unknown; Node: unknown };
  };
  const worker = readFileSync(resolve(import.meta.dir, "..", "src", "adapters", "chatgpt-web", "browser-worker.ts"), "utf8");
  const source = worker.split("// CHATGPT_MARKDOWN_CONTENT_BEGIN")[1]
    ?.split("// CHATGPT_MARKDOWN_CONTENT_END")[0];
  if (!source) throw new Error("Markdown content projection is missing from browser-worker.ts");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const window = createWindow();
  const { contentFor, textFor } = new Function(
    "HTMLElement",
    "Node",
    `${javascript}; return { contentFor: chatGptMarkdownContent, textFor: markdownText };`,
  )(window.HTMLElement, window.Node) as {
    contentFor(root: HTMLElement): HTMLElement;
    textFor(root: HTMLElement): string;
  };

  const prose = '<p data-start="0" data-end="20">Keep 正在加载图表… literally.</p>';
  const code = '<pre data-start="22" data-end="80"><code class="language-vega-lite">{"mark":"line"}</code></pre>';
  const tail = '<ol start="3"><li><p>Actual answer</p></li></ol><span>Inline tail</span>';
  const expected = chatGptHtmlToMarkdown(prose + code + tail);
  for (const label of ["Creating chart", "正在加载图表…", "Preview failed"]) {
    const before = createDocument(prose + code + '<button><span class="sr-only">Copy</span></button>'
      + '<span class="contents"><div aria-busy="true" class="chart-widget-container">'
      + `<section><div role="status">${label}</div></section></div></span>`
      + `<div data-start="82" data-end="150"><div data-code-block-preview-pane="vega-lite">${label}</div></div>`
      + tail).body;
    const original = before.innerHTML;
    const projected = contentFor(before);
    const after = createDocument(prose + code + '<button><span class="sr-only">Copied</span></button>'
      + '<span class="contents"><div class="chart-widget-container">'
      + '<button>Chart options</button><svg><text>0369Day 1Day 2</text></svg></div></span>'
      + '<div data-start="82" data-end="150"><div data-code-block-preview-pane="vega-lite"><iframe title="Preview"></iframe></div></div>'
      + tail).body;
    const hydrated = contentFor(after);
    expect(projected.innerHTML).toBe(hydrated.innerHTML);
    expect(projected.textContent).toBe(hydrated.textContent);
    expect(textFor(projected)).toBe(textFor(hydrated));
    expect(chatGptHtmlToMarkdown(projected.innerHTML)).toBe(expected);
    expect(before.innerHTML).toBe(original);
    expect(projected.querySelector("pre")?.getAttribute("data-start")).toBe("22");
  }

  const text = (html: string) => textFor(contentFor(createDocument(html).body));
  expect(text("<p>A<br>B</p>")).not.toBe(text("<p>AB</p>"));
  expect(text("<pre><code>one\n\ntwo</code></pre>"))
    .not.toBe(text("<pre><code>one\ntwo</code></pre>"));
  expect(text("<div>A</div><div>B</div>"))
    .toBe(text("<section><div>A</div><div>B</div></section>"));
});
