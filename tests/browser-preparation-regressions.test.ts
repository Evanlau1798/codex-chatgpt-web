import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { Browser, Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import { readChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-text";
import { launchDomBrowser } from "./support/dom-browser";
import { pasteChatGptComposerLiteralText } from "../src/adapters/chatgpt-web/composer-literal-paste";
import { assertNewChatPage, CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR } from "../src/chatgpt-session";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";

let browser: Browser;
beforeAll(async () => { if (process.env.CHATGPT_DOM_TEST_BROWSER) browser = await launchDomBrowser(); }, 30_000);
afterAll(async () => { await browser?.close(); });
const domTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);

// 2026-11-24: captured from the authenticated isolated launcher's Temporary Chat header.
domTest.each([16, 20])("temporary chat recognizes filled incognito %i header icons without trusting URL or unrelated glyphs", async size => {
  const page = await browser.newPage();
  try {
    await page.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
    await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded" });
      const icon = `<button aria-label="Turn off temporary chat"><svg><use href="#codex-icon-incognito-fill-light-${size}"></use></svg></button>`;
      const menu = '<button aria-haspopup="menu" data-personalization>Personalization</button>';
      await page.setContent(`<header><div><button aria-haspopup="menu">GPT-6.2</button></div><div>${menu}${icon}</div></header><main>${menu}${icon}</main>`, { waitUntil: "domcontentloaded" });
      await expect(assertNewChatPage(page)).resolves.toBeUndefined();
      expect(await page.locator(CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR).count()).toBe(1);
      expect(await page.locator(CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR).getAttribute("data-personalization")).toBe("");
      await page.locator("header").evaluate(element => element.remove());
      await expect(assertNewChatPage(page)).rejects.toThrow("rendered chat mode");
      expect(await page.locator(CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR).count()).toBe(0);
      await page.setContent(`<header hidden><div>${menu}${icon}</div></header>`, { waitUntil: "domcontentloaded" });
      await expect(assertNewChatPage(page)).rejects.toThrow("rendered chat mode");
      expect(await page.locator(CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR).filter({ visible: true }).count()).toBe(0);
      await page.evaluate(() => history.replaceState(null, "", "/"));
      await page.setContent(`<header>${icon}</header>`, { waitUntil: "domcontentloaded" });
      await expect(assertNewChatPage(page, true)).rejects.toThrow("rendered chat mode");
  } finally { await page.close(); }
});

domTest("current header native preflight binds the owned control and preserves input failure", async () => {
  const page = await browser.newPage();
  const selected: Array<string | null> = [];
  // Fail only the external input boundary; production selector and cleanup stay real.
  const click = spyOn(Object.getPrototypeOf(page.locator("body")), "click")
    .mockImplementation(async function(this: Locator) {
      selected.push(await this.getAttribute("id"));
      throw new Error("fixture input delivery failed");
    });
  try {
    await page.setContent(`<header><div><button id="privacy-control" aria-haspopup="menu" aria-expanded="false">Personalization</button>
      <button><svg><use href="#codex-icon-incognito-fill-light-20"></use></svg></button></div></header>`);
    await expect(ensureChatGptPersonalizedConnectorAccess(page, undefined, async () => false))
      .rejects.toThrow("fixture input delivery failed");
    expect(selected).toEqual(["privacy-control"]);
    expect(await page.locator("#privacy-control").getAttribute("aria-expanded")).toBe("false");
  } finally {
    click.mockRestore(); await page.close();
  }
}, 40_000);

domTest("scrolling previously observed history cannot acknowledge Send after helper replacement", async () => {
  const page = await browser.newPage();
  try {
    const group = (id: string) => `<div data-turn-key="${id}"><div data-user-message-bubble>${id}</div><div data-conversation-role="assistant">Answer</div></div>`;
    const old = ["top", "middle", "bottom"].map(group).join("");
    await page.setContent(`<main>${old}</main>`);
    const first = Object.create(ChatGptBrowserWorker.prototype) as any;
    await first.captureSubmissionBaseline(page, "Observed");
    await page.locator("main").evaluate(node => node.replaceChildren());
    const second = Object.create(ChatGptBrowserWorker.prototype) as any;
    const baseline = await second.captureSubmissionBaseline(page, "Next");
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, old);
    expect(await second.currentSubmissionEvidence(page, baseline)).toBeUndefined();
    await page.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), group("new"));
    expect(await second.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:new");
    await page.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), group("competing"));
    await expect(second.currentSubmissionEvidence(page, baseline)).rejects.toThrow("2 new conversation turns");
    await page.goto("about:blank");
    await page.setContent("<main></main>");
    const fresh = await second.captureSubmissionBaseline(page, "Next");
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, old);
    await expect(second.currentSubmissionEvidence(page, fresh)).rejects.toThrow("3 new conversation turns");
  } finally { await page.close(); }
});

domTest("owned plain insertion replaces a restored draft and preserves literal Markdown", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="composer" contenteditable="true">restored stale draft</div>');
    await page.locator("#composer").evaluate(element => {
      element.addEventListener("paste", raw => {
        const event = raw as ClipboardEvent;
        event.preventDefault();
        document.execCommand("insertText", false, event.clipboardData!.getData("text/plain"));
      });
    });
    const composer = page.locator("#composer");
    await composer.focus();
    await composer.press("End");
    const prompt = '```json\n{"literal":"**x** _y_"}\n```';
    await insertChatGptPromptText(prompt, undefined, {
      composer: async () => composer,
      verify: async text => { expect(await composer.evaluate(readChatGptPromptText, { preserveLeading: true })).toBe(text); },
      reanchor: async () => {},
      replaceExisting: true,
    });
    expect(await composer.evaluate(readChatGptPromptText, { preserveLeading: true })).toBe(prompt);
  } finally { await page.close(); }
});

domTest("refuses plain replacement when focus cannot enter the composer (#977)", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button>Other control</button><div id="composer" contenteditable="true">old draft</div>');
    await page.locator("#composer").evaluate(element => {
      element.addEventListener("focus", () => document.querySelector("button")!.focus());
      element.addEventListener("paste", () => { element.textContent = "unexpected paste"; });
    });
    await expect(pasteChatGptComposerLiteralText(page.locator("#composer"), "new request", undefined,
      undefined, undefined, undefined, true)).rejects.toThrow("rejected the literal plain-text paste");
    expect(await page.locator("#composer").innerText()).toBe("old draft");
  } finally { await page.close(); }
});

domTest("multipart attachment replaces a draft restored after the initial clear", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<form><div id="prompt-textarea" contenteditable="true" style="min-height:40px">old draft</div></form>');
    await page.locator("#prompt-textarea").evaluate(element => {
      element.addEventListener("input", () => {
        if (!element.textContent) queueMicrotask(() => {
          element.textContent = "restored old draft ".repeat(3_000);
          element.setAttribute("data-draft-restored", "true");
        });
      }, { once: true });
      element.addEventListener("paste", raw => {
        const event = raw as ClipboardEvent;
        event.preventDefault();
        document.execCommand("insertText", false, event.clipboardData!.getData("text/plain"));
      });
    });
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName: "Codex Native2" } });
    const prompt = 'Current stage\n```json\n{"text":"keep literal Markdown"}\n```\n' + "context ".repeat(24_000) + "END";
    await worker.attachPrompt(page, prompt, false);
    expect(await page.locator("#prompt-textarea").getAttribute("data-draft-restored")).toBe("true");
    expect(await worker.attachedPromptText(page)).toBe(prompt);
    await worker.attachPrompt(page, "Next stage\nwith a different request", false);
    expect(await worker.attachedPromptText(page)).toBe("Next stage\nwith a different request");
  } finally { await page.close(); }
}, 30_000);
