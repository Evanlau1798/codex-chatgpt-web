import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { assertNewChatPage, CHATGPT_TEMPORARY_CHAT_ACTIVE_SELECTOR } from "../src/chatgpt-session";

test.each([false, true])("new-chat verification requires rendered mode to match preference (%s)", async saved => {
  let visible = !saved;
  const marker = { count: async () => 1, nth: () => marker, isVisible: async () => visible };
  const page = { url: () => saved ? "https://chatgpt.com/" : "https://chatgpt.com/?temporary-chat=true",
    locator: () => marker } as any;
  await expect(assertNewChatPage(page, saved)).resolves.toBeUndefined();
  visible = saved;
  await expect(assertNewChatPage(page, saved)).rejects.toThrow("rendered chat mode");
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("Temporary Chat proof recognizes captured headers, not hidden or unrelated icons", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const icon of ["codex-icon-chat-bubble-checkmark-dashed-light-20", "chat-bubble-checkmark-dashed-light-20", "chat-temp-checked"]) {
      await page.setContent(`<header><button id="active"><svg><use href="/assets.svg#${icon}"></use></svg></button>
        <button id="hidden" style="display:none"><svg><use href="/assets.svg#${icon}"></use></svg></button></header>
        <button id="decoy"><svg><use href="/assets.svg#${icon}"></use></svg></button>`);
      expect(await page.locator(CHATGPT_TEMPORARY_CHAT_ACTIVE_SELECTOR).filter({ visible: true }).evaluateAll(nodes => nodes.map(node => node.id)))
        .toEqual(["active"]);
    }
  } finally { await browser.close(); }
});
