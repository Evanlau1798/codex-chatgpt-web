// Serialized into an automatic browser surface. Keep this function self-contained.
function configureChatGptAnnouncementDismissal(enabled) {
  const key = "__CODEX_WEB_GPT_ANNOUNCEMENT_OBSERVER__";
  if (!enabled) {
    globalThis[key]?.disconnect();
    delete globalThis[key];
    return;
  }
  if (location.origin !== "https://chatgpt.com" || globalThis[key]) return;

  const attempted = new WeakSet();
  const visible = element => element.getClientRects().length > 0
    && !element.closest('[hidden], [aria-hidden="true"]')
    && getComputedStyle(element).visibility !== "hidden";
  const dismiss = () => {
    // ChatGPT's announcement/onboarding renderer owns modal-beacon. close-button
    // is shared with unrelated dialogs, so it is never sufficient on its own.
    const dialogs = [...document.querySelectorAll(
      '[data-testid="modal-beacon"] [role="dialog"][data-state="open"]',
    )].filter(visible);
    if (dialogs.length !== 1) return;
    const dialog = dialogs[0];
    const buttons = [...dialog.querySelectorAll('button[data-testid="close-button"]')]
      .filter(button => button.closest('[role="dialog"]') === dialog && visible(button));
    if (buttons.length !== 1) return;
    const button = buttons[0];
    if (button.matches(':disabled, [aria-disabled="true"]') || attempted.has(button)) return;
    attempted.add(button);
    button.click();
  };
  const observer = new MutationObserver(records => {
    // Streaming answers mutate constantly. Only rescan when a banner is inserted
    // or its own subtree changes, rather than searching the transcript each time.
    const selector = '[data-testid="modal-beacon"]';
    if (records.some(record => (
      record.target instanceof Element && record.target.closest(selector)
    ) || [...record.addedNodes].some(node => node instanceof Element
      && (node.matches(selector) || node.querySelector(selector))))) dismiss();
  });
  Object.defineProperty(globalThis, key, { value: observer, configurable: true });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-testid", "data-state", "hidden", "aria-hidden", "disabled", "aria-disabled", "class", "style"],
  });
  dismiss();
}

module.exports = { configureChatGptAnnouncementDismissal };
