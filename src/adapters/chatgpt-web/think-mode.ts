import type { Locator } from "playwright-core";
import { CHATGPT_THINK_BUTTON_SELECTOR } from "../../chatgpt-session";
import { withAbort } from "./runtime-lifecycle";
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("ChatGPT Think selection aborted", "AbortError");
}
export function chatGptThinkButtons(composer: Locator): Locator {
  const form = composer.locator("xpath=ancestor::form[1]");
  // Keep the semantic button used before 6.1.8 alongside the captured localized
  // glyph. Both identify the same action; never substitute a composer command.
  return form.locator(CHATGPT_THINK_BUTTON_SELECTOR)
    .or(form.getByRole("button", { name: "Think", exact: true }))
    .filter({ visible: true });
}
export async function setChatGptThinkMode(
  composer: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfAborted(abortSignal);
  const controls = chatGptThinkButtons(composer);
  let count = await controls.count();
  if (count === 0 && !enabled) {
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count === 0) {
    // The editor can mount before its controls. Wait for the actual button;
    // typing /think here can become a literal prompt or remove the plugin pill.
    await controls.first().waitFor({ state: "visible", timeout: 5_000, signal: abortSignal });
    count = await controls.count();
  }
  if (count === 0) throw new Error("ChatGPT did not expose a visible Think button");
  if (count > 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  const actionOptions = { signal: abortSignal, timeout: 10_000 };
  let pressed = await control.getAttribute("aria-pressed", actionOptions);
  if (pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    const composerState = () => composer.evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement;
      const pills = [...copy.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]',
      )];
      const connectors = pills.map(pill => (
        pill.getAttribute("data-id") ?? pill.getAttribute("app-mention-path")
      )).sort();
      for (const pill of pills) pill.remove();
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value : copy.textContent ?? "";
      return { text: text.trim(), connectors };
    }, undefined, actionOptions);
    const before = await composerState();
    if (before.text) throw new Error("ChatGPT Think selection requires an empty prompt draft");
    await control.click(actionOptions);
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
      await withAbort(new Promise(resolveSleep => setTimeout(resolveSleep, 100)), abortSignal);
    }
    if (pressed !== target) {
      throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    }
    const after = await composerState();
    if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
      throw new Error("ChatGPT Think selection did not preserve the empty draft and selected connectors");
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}
