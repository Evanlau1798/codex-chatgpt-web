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
