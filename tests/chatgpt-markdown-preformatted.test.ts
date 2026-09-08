import { expect, test } from "bun:test";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("preserves semantic preformatted blocks rendered with nested elements", () => {
  const html = [
    "<pre>",
    "<button>Copy</button>",
    "<div>",
    '<div><span>alpha</span></div>',
    "<div>  beta</div>",
    "<div><br></div>",
    "<div>gamma</div>",
    "</div>",
    "</pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe("```\nalpha\n  beta\n\ngamma\n```");
});

test("links Obsidian notes without turning their brackets into LaTeX delimiters", () => {
  expect(chatGptHtmlToMarkdown(
    "<p>Sources: [[Goals/financial goals]] · [[wiki/entities/me]]</p>",
  )).toBe("Sources: [Goals/financial goals](<Goals/financial goals.md>) · [wiki/entities/me](<wiki/entities/me.md>)");
  expect(chatGptHtmlToMarkdown("<p>Ordinary [brackets] stay escaped</p>"))
    .toBe("Ordinary \\[brackets\\] stay escaped");
});

test("preserves the exact outer Codex plan envelope", () => {
  expect(chatGptHtmlToMarkdown(
    "<p>&lt;proposed_plan&gt;</p><p>Keep an_inner_value unchanged.</p><p>&lt;/proposed_plan&gt;</p>",
  )).toBe("<proposed_plan>\n\nKeep an\\_inner\\_value unchanged.\n\n</proposed_plan>");
});
