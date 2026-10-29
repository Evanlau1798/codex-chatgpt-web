import { launchDomBrowser } from "./support/dom-browser";
import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, throwIfChatGptDeliveryTimeoutAlert, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptAssistantTurnSelector, chatGptTurnContainerSelector } from "../src/chatgpt-ui/turns";

const deliveryError = "Message delivery timed out. Please try again.";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("delivery timeout belongs to a visible service alert in the current response, without Stop", async () => {
  const browser = await launchDomBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<section data-turn-key="old"><aside role="alert">${deliveryError}</aside></section>
      <section data-turn-key="current"><div data-user-message-bubble>Prompt</div><div id="variant"></div></section>`);
    const current = page.locator(chatGptTurnContainerSelector("group:assistant:current"));
    for (const markup of [
      `<div class="markdown"><aside role="alert">${deliveryError}</aside></div>`,
      `<div data-user-message-bubble><aside role="alert">${deliveryError}</aside></div>`,
      `<div contenteditable="true"><aside role="alert">${deliveryError}</aside></div>`,
      `<div hidden><aside role="alert">${deliveryError}</aside></div>`,
      `<div aria-hidden="true"><aside role="alert">${deliveryError}</aside></div>`,
      `<div data-turn-key="foreign"><aside role="alert">${deliveryError}</aside></div>`,
      `<aside role="alert" style="visibility:hidden">${deliveryError}</aside>`,
      `<aside role="alert">The model said: ${deliveryError}</aside>`,
      `<aside role="alert">Network error in my application</aside>`,
      `<div>${deliveryError}</div>`,
    ]) {
      await page.locator('#variant').evaluate((element, html) => { element.innerHTML = html; }, markup);
      await expect(throwIfChatGptDeliveryTimeoutAlert(page, current)).resolves.toBeUndefined();
    }
    await page.locator('#variant').evaluate((element, text) => { element.innerHTML = `<aside role="alert">${text}</aside>`; }, deliveryError);
    // This exact service failure was invisible to the pre-existing terminal-error check.
    await expect(throwIfChatGptTerminalErrorAlert(current)).resolves.toBeUndefined();
    await page.locator('body').evaluate(element => element.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>'));
    await expect(throwIfChatGptDeliveryTimeoutAlert(page, current)).resolves.toBeUndefined();
    await page.getByTestId('stop-button').evaluate(element => element.remove());
    await expect(throwIfChatGptDeliveryTimeoutAlert(page, current)).rejects.toMatchObject({
      code: "chatgpt_delivery_timeout", status: 503, retryable: true,
    });
    await page.locator('#variant').evaluate(element => element.remove());
    await expect(throwIfChatGptDeliveryTimeoutAlert(page, current)).resolves.toBeUndefined();
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a damaged staging acknowledgement fails exactly and permits restarting before the final commit", async () => {
  const browser = await launchDomBrowser();
  try {
    const expected = `CODEX_MULTIPART_ACK ctx_current 5/6 ${"a".repeat(64)}`;
    for (const actual of [expected, expected.slice(0, -2), expected.replace('ctx_current', 'ctx_other')]) {
      const page = await browser.contexts()[0]!.newPage();
      await page.setContent(`<section data-turn-key="current"><div data-user-message-bubble>Stage 5</div>
        <div data-content-search-unit-key="current:assistant"><div data-conversation-role="assistant"></div><div class="markdown"><p>${actual}</p></div></div>
        <div class="turn-action-controls"><button data-testid="copy-turn-action-button">Copy</button></div></section>`);
      const identity = 'group:assistant:current';
      expect(await page.locator(chatGptAssistantTurnSelector(identity)).count()).toBe(1);
      const binding = { identity, locator: page.locator('[data-turn-key="current"]'), acceptedTurnIdentities: [identity] };
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const snapshots: unknown[] = [];
      page.on('pageerror', error => snapshots.push({ pageError: error.message }));
      const evaluate = binding.locator.evaluate.bind(binding.locator);
      binding.locator.evaluate = async (...args: any[]) => {
        const startedAt = Date.now();
        try { return await (evaluate as any)(...args); }
        catch (error) {
          snapshots.push({ evaluationFailure: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
          throw error;
        }
        finally { snapshots.push({ evaluateStartedAt: startedAt, elapsedMs: Date.now() - startedAt }); }
      };
      const snapshot = worker.responseDomSnapshot.bind(worker);
      worker.responseDomSnapshot = async (...args: unknown[]) => {
        const value = await snapshot(...args);
        snapshots.push({ at: Date.now(), responsePresent: value.responsePresent,
          text: value.visibleText, html: value.fullHtml, completion: value.completionActionVisible, projection: value.projection });
        return value;
      };
      const inspected = await worker.responseDomSnapshot(binding.locator);
      expect(inspected.visibleText).toBe(actual);
      expect(inspected.completionActionVisible).toBeTrue();
      const result = worker.waitForMultipartAcknowledgement(page, binding.locator,
        { acknowledgement: expected }, Date.now() + 15_000, undefined, undefined, undefined,
        page.locator(chatGptTurnContainerSelector(identity))).catch((error: unknown) => {
          if (error instanceof Error && !('code' in error)) console.error(JSON.stringify({ acknowledgementObservation: snapshots }));
          throw error;
        });
      if (actual === expected) expect(await result).toBeUndefined();
      else {
        const failure = await result.then(() => undefined, (error: unknown) => error);
        expect(failure).toMatchObject({ code: 'multipart_acknowledgement_mismatch', retryable: true });
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 60_000);
