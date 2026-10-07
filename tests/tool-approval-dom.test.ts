import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { resolveChatGptToolConfirmation } from "../src/adapters/chatgpt-web/browser-worker";

const domTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);

async function withPage(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try { await run(await browser.newPage()); } finally { await browser.close(); }
}

// Structure reported in #768: the owned surface contains an alert and a split button.
function card(app = "Codex Native2", actions = "Allow once", attribute = 'data-codex-approval-surface="true"') {
  return `<section ${attribute}><div role="alert"><p>Allow ChatGPT to use ${app}?</p>
    <button onclick="this.closest('section').remove()">Deny</button>
    <div><button onclick="document.body.dataset.chosen=this.textContent;this.closest('section').remove()">${actions}</button>
    <button aria-label="Approval options">Options</button></div></div></section>`;
}

domTest("current and earlier approval surfaces select only the visible one-time action", async () => {
  await withPage(async page => {
    for (const attribute of ['data-codex-approval-surface="true"', 'role="dialog"', 'data-testid="tool-approval-card"']) {
      await page.setContent(card("Codex Native2", "Allow once", attribute) + '<button hidden>Allow once</button>');
      expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeTrue();
      expect(await page.locator("body").getAttribute("data-chosen")).toBe("Allow once");
    }
  });
}, 20_000);

domTest("approval cannot choose another connector, a quoted alert, or ambiguous permission controls", async () => {
  await withPage(async page => {
    for (const html of [card("GitHub"), card("Codex Native2 extra"), card("Codex Native2", "Allow once", 'class="answer-text"')]) {
      await page.setContent(html);
      expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeFalse();
      expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
    }
    for (const html of [card() + card(), card().replace("</section>", "<button>Allow once</button></section>")]) {
      await page.setContent(html);
      let failure: unknown;
      try { await resolveChatGptToolConfirmation(page, "Codex Native2", true); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
    }
  });
}, 20_000);

domTest("a pending current approval stays manual and respects cancellation", async () => {
  await withPage(async page => {
    await page.setContent(card());
    const controller = new AbortController();
    const pending: boolean[] = [];
    let failure: unknown;
    try {
      await resolveChatGptToolConfirmation(page, "Codex Native2", false, controller.signal, 1_000,
        undefined, async value => { pending.push(value); if (value) controller.abort(); });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(pending).toEqual([true, false]);
    expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
  });
}, 20_000);

domTest("an approval waits for its actions to finish mounting", async () => {
  await withPage(async page => {
    await page.setContent(card());
    await page.locator("section").evaluate(element => {
      const buttons = [...element.querySelectorAll("button")];
      buttons.forEach(button => { button.hidden = true; });
      setTimeout(() => buttons.forEach(button => { button.hidden = false; }), 100);
    });
    expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeTrue();
    expect(await page.locator("section").count()).toBe(0);
    expect(await page.locator("body").getAttribute("data-chosen")).toBe("Allow once");
  });
}, 20_000);
