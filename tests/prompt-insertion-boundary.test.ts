import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test("native prompt chunks keep boundary whitespace in the preceding edit", async () => {
  const prompt = `${"word ".repeat(4_000)}tail`;
  const inserted: string[] = [];
  let attached = "";
  const page = {
    keyboard: {
      insertText: async (value: string) => {
        inserted.push(value);
        if (attached.endsWith("\u00A0") && value) attached = `${attached.slice(0, -1)} `;
        const committed = attached && value.startsWith(" ") ? value.slice(1) : value;
        attached += committed.endsWith(" ") ? `${committed.slice(0, -1)}\u00A0` : committed;
      },
    },
  };
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, input: unknown) => {
      if (Array.isArray(input)) return input.every(marker => !attached.includes(String(marker)));
      const replacements = (input as { replacements: Array<{ marker: string; value: string }> }).replacements;
      for (const replacement of replacements) {
        attached = attached.replace(replacement.marker, replacement.value);
      }
      return replacements.length;
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async () => attached,
    activeComposer: async () => composer,
    reanchorPromptCaret: async () => {},
  }) as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  };

  await worker.insertPromptText(page, prompt);

  expect(inserted.length).toBeGreaterThan(1);
  expect(inserted.slice(1).every(chunk => !chunk.startsWith(" "))).toBeTrue();
  expect(attached).toBe(prompt);
});
