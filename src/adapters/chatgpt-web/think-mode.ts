import type { Locator } from "playwright-core";

export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
): Promise<void> {
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0) {
    if (enabled) throw new Error("ChatGPT Think control is not available on this Luna-only account");
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count !== 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  let pressed = await control.getAttribute("aria-pressed");
  if (pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    await control.click();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      pressed = await control.getAttribute("aria-pressed");
      if (pressed === target) break;
      if (pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (pressed !== target) throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}
