import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { dismissChatGptTemporaryChatOnboarding } from "../src/adapters/chatgpt-web/temporary-chat-onboarding";

function fixture(text: string, label: string) {
  let matches = true, visible = true, clicks = 0;
  const dialog = {
    filter: ({ hasText }: { hasText: string | RegExp }) => {
      matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => visible && matches,
    waitFor: async () => { expect(visible).toBeFalse(); },
    getByRole: (_role: string, { name }: { name: string | RegExp }) => {
      const button = {
        last: () => button,
        isVisible: async () => typeof name === "string" ? name === label : name.test(label),
        click: async () => { clicks++; visible = false; },
      };
      return button;
    },
  };
  return { page: { locator: () => dialog } as unknown as Page, clicks: () => clicks };
}

test.each([
  ["Not in history. No model training. Memory off.", "Continue"],
  ["Pas de conservation dans l’historique. Aucun entraînement de modèle. Mémoire désactivée.", "Continuer"],
  ["Pas de conservation dans l'historique. Aucun entraînement de modèle. Mémoire désactivée.", "Continuer"],
])("recognized Temporary Chat onboarding closes once: %s", async (text, label) => {
  const ui = fixture(text, label);
  expect(await dismissChatGptTemporaryChatOnboarding(ui.page)).toBeTrue();
  expect(ui.clicks()).toBe(1);
});

test.each([
  "Pas de conservation dans l’historique. Aucun entraînement de modèle.",
  "Mémoire désactivée. Continuer une autre opération.",
])("partial French dialog evidence never activates Continue: %s", async text => {
  const ui = fixture(text, "Continuer");
  expect(await dismissChatGptTemporaryChatOnboarding(ui.page)).toBeFalse();
  expect(ui.clicks()).toBe(0);
});

test("French onboarding does not select a similarly named action", async () => {
  const ui = fixture("Pas de conservation dans l’historique. Aucun entraînement de modèle. Mémoire désactivée.", "Continuer et supprimer");
  await expect(dismissChatGptTemporaryChatOnboarding(ui.page)).rejects.toThrow("Continue action");
  expect(ui.clicks()).toBe(0);
});
