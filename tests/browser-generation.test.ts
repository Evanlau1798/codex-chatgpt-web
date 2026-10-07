import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { chatGptStopButton, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("hidden duplicate Stop controls cannot turn live generation into an idle timeout", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-testid="stop-button">Stop</button>'
      + '<form data-chatgpt-composer><button type="button" aria-label="Stop" hidden>Stop</button></form>');
    const health = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
    const idle = { responsePresent: true, currentText: "", completionActionVisible: false, running: false };
    const stop = chatGptStopButton(page);
    expect(await stop.isVisible()).toBeTrue();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 0)).toBeUndefined();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_000)).toBeUndefined();
    await page.getByTestId("stop-button").evaluate(element => element.remove());
    expect(await stop.isVisible()).toBeFalse();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_000)).toBeUndefined();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_750)).toContain("without a final answer");
  } finally {
    await browser.close();
  }
});
