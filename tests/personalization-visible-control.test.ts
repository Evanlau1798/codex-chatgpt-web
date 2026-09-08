import { expect, test } from "bun:test";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";

function visibleLocator(count: () => number, overrides: Record<string, unknown> = {}) {
  const locator = {
    filter: () => locator,
    count: async () => count(),
    ...overrides,
  };
  return locator;
}

for (const [label, ariaHidden] of [["Personalized", false], ["Personalized", true], ["个性化", false]] as const) test(`a visible ${label} control is a preflight no-op (aria-hidden=${ariaHidden})`, async () => {
  const diagnostics: string[] = [];
  const personalized = visibleLocator(() => 1);
  const unpersonalized = visibleLocator(() => 0);
  const page = {
    getByRole: (_role: string, options: { name: string | RegExp; includeHidden?: boolean }) => (
      (typeof options.name === "string" ? options.name === label : options.name.test(label))
        && (!ariaHidden || options.includeHidden) ? personalized : unpersonalized
    ),
  } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
  )).toBe("already-personalized");
  expect(diagnostics).toEqual(["personalization-already-enabled"]);
});
