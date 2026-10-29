import { launchDomBrowser } from "./support/dom-browser";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHATGPT_UI_VARIANT_SELECTORS, chatGptUiVariantCounts } from "../src/chatgpt-ui/observations";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("UI observations distinguish coexisting and hidden variants without retaining page content", async () => {
  const browser = await launchDomBrowser();
  try {
    const page = await browser.newPage();
    const sprite = (date: string) => readFileSync(new URL(`./fixtures/chatgpt-composer-think-${date}.html`, import.meta.url), "utf8");
    await page.setContent(`<form data-chatgpt-composer>
      <div data-composer-markdown role="textbox" contenteditable="true">private draft turn_01234567890123456789012345678901</div>
      ${sprite("2026-10-28")}
    </form>
    <section hidden><form><div id="prompt-textarea" contenteditable="true">hidden private draft</div>${sprite("2026-10-11")}</form></section>
    <div data-model-picker-power-slider><span role="slider" aria-hidden="true"></span></div>
    <article data-testid="conversation-turn-1" data-turn-id="private-article">private history</article>
    <div data-turn-key="private-group"><article data-testid="conversation-turn-2">nested old-looking markup</article></div>`);
    const observed = await page.evaluate(chatGptUiVariantCounts, CHATGPT_UI_VARIANT_SELECTORS);
    expect(observed["composer.markdown"]).toEqual({ attached: 1, rendered: 1 });
    expect(observed["composer.lexical"]).toEqual({ attached: 1, rendered: 0 });
    expect(observed["think.codexSprite"]).toEqual({ attached: 1, rendered: 1 });
    expect(observed["think.brainSprite"]).toEqual({ attached: 1, rendered: 0 });
    expect(observed["slider.power"]).toEqual({ attached: 1, rendered: 1 });
    expect(observed["turn.article"]).toEqual({ attached: 1, rendered: 1 });
    expect(observed["turn.grouped"]).toEqual({ attached: 1, rendered: 1 });
    expect(JSON.stringify(observed)).not.toMatch(/private|turn_012|conversation-turn|data-turn-key/);
    expect(await page.locator('[data-composer-markdown]').innerText()).toContain('private draft');
    await page.locator('body').evaluate(body => {
      for (let index = 0; index < 60; index++) {
        const node = document.createElement('div'); node.setAttribute('data-turn-key', String(index)); body.append(node);
      }
    });
    const bounded = await page.evaluate(chatGptUiVariantCounts, CHATGPT_UI_VARIANT_SELECTORS);
    expect(bounded["turn.grouped"]).toEqual({ attached: 40, rendered: 40 });
    const { sanitizeForExport } = require("../launcher/electron/logging.cjs");
    const exported = sanitizeForExport(JSON.stringify(bounded));
    expect(exported).not.toContain("[truncated]");
    expect(JSON.parse(exported)).toEqual(bounded);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("model control observations count retained and inline variants without labels or effort values", async () => {
  const browser = await launchDomBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<form>
      <button aria-haspopup="menu" data-tone="neutral">private neutral</button>
      <button hidden aria-haspopup="menu" data-testid="model-switcher-dropdown-button">private dropdown</button>
      <button aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning">private codex</button>
      <button type="button" aria-haspopup="menu" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="max" aria-label="选择 ChatGPT 模型">private inline</button>
      <section hidden><button aria-haspopup="menu" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium">hidden private inline</button></section>
      <button aria-haspopup="menu" data-composer-navigation-target="reasoning">unrelated</button>
      <button aria-haspopup="menu" data-selected-reasoning-effort="max">unrelated</button>
    </form>`);
    const observed = await page.evaluate(chatGptUiVariantCounts, CHATGPT_UI_VARIANT_SELECTORS);
    expect(observed["modelControl.neutral"]).toEqual({ attached: 1, rendered: 1 });
    expect(observed["modelControl.dropdown"]).toEqual({ attached: 1, rendered: 0 });
    expect(observed["modelControl.codexReasoning"]).toEqual({ attached: 1, rendered: 1 });
    expect(observed["modelControl.inlineReasoning"]).toEqual({ attached: 2, rendered: 1 });
    expect(JSON.stringify(observed)).not.toMatch(/private|选择|ChatGPT|max|medium|data-selected/);
  } finally { await browser.close(); }
}, 15_000);
