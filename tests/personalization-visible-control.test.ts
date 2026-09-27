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

for (const [label, ariaHidden] of [["Personalized", false], ["Personalized", true], ["Personnalisé", false], ["Personnalisé", true], ["个性化", false], ["個人化", false]] as const) test(`a visible ${label} control is a preflight no-op (aria-hidden=${ariaHidden})`, async () => {
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

test("French unpersonalized control selects its owned personalized choice and verifies the resulting state", async () => {
  let enabled = false, menuOpen = false, clicks = 0;
  const choice = {
    filter: ({ hasText }: { hasText: RegExp }) => { expect(hasText.test("Personnalisé Ce chat peut utiliser les plugins")).toBeTrue(); return choice; },
    count: async () => 1,
    click: async () => { enabled = true; menuOpen = false; clicks++; },
  };
  const menu = { waitFor: async () => { expect(menuOpen).toBeTrue(); }, locator: () => choice };
  const control = (personal: boolean) => visibleLocator(() => Number(personal === enabled), {
    click: async () => { expect(personal).toBeFalse(); menuOpen = true; },
    getAttribute: async () => "personalization-menu",
    waitFor: async ({ state }: { state: string }) => { expect(personal === enabled).toBe(state === "visible"); },
  });
  const page = {
    getByRole: (_role: string, { name }: { name: RegExp }) => {
      if (name.test("Personnalisé")) return control(true);
      expect(name.test("Non personnalisé")).toBeTrue();
      return control(false);
    },
    locator: (selector: string) => { expect(selector).toBe('[id="personalization-menu"]'); return menu; },
  } as any;
  expect(await ensureChatGptPersonalizedConnectorAccess(page)).toBe("enabled");
  expect(enabled).toBeTrue();
  expect(clicks).toBe(1);
});
