import type { Locator } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR } from "../../chatgpt-session";

const ACTION_TIMEOUT_MS = 10_000;
const DOCUMENT_END_KEY = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("ChatGPT Think selection aborted", "AbortError");
}

export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfAborted(abortSignal);
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0 && !enabled) {
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count > 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  const actionOptions = { signal: abortSignal, timeout: ACTION_TIMEOUT_MS };
  let pressed = count === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
  if (count === 1 && pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    const composer = composerForm.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    const composerState = () => composer.evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement;
      const pills = [...copy.querySelectorAll('[data-id^="plugin:"][data-keyword]')];
      const connectors = pills.map(pill => pill.getAttribute("data-keyword")).sort();
      for (const pill of pills) pill.remove();
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value : copy.textContent ?? "";
      return { text: text.trim(), connectors };
    }, undefined, actionOptions);
    const before = await composerState();
    if (before.text) throw new Error("ChatGPT Think selection requires an empty prompt draft");
    await composer.focus(actionOptions);
    await composer.press(DOCUMENT_END_KEY, actionOptions);
    await composer.pressSequentially("/think", { ...actionOptions, delay: 25 });
    await captureDiagnostic?.("think-slash-triggered");
    const popup = composerForm.page().locator('.popover[aria-busy="false"]').filter({ visible: true });
    const rows = popup.locator('.__menu-item[tabindex="0"]').filter({ visible: true });
    await rows.first().waitFor({ state: "visible", timeout: 5_000, signal: abortSignal });
    if (await popup.count() !== 1 || await rows.count() !== 1) {
      throw new Error("ChatGPT Think slash menu must expose exactly one command option");
    }
    const row = rows.first();
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      await composer.press("ArrowDown", actionOptions);
    }
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      throw new Error("ChatGPT Think slash option is not highlighted");
    }
    await captureDiagnostic?.("think-slash-menu-ready");
    throwIfAborted(abortSignal);
    await composer.press("Enter", actionOptions);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      throwIfAborted(abortSignal);
      const currentCount = await controls.count();
      if (currentCount > 1) throw new Error(`ChatGPT exposed ${currentCount} visible Think controls`);
      pressed = currentCount === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
      if (pressed === target) break;
      if (currentCount === 1 && pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(abortSignal.reason ?? new DOMException("ChatGPT Think selection aborted", "AbortError"));
        }, { once: true });
      });
    }
    if (pressed !== target) throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    const after = await composerState();
    if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
      throw new Error("ChatGPT Think slash selection did not preserve the empty draft and selected connectors");
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}
