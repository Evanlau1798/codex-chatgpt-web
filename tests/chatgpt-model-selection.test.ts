import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

// The 2026-10-06 live picker omits aria-hidden on its visible model-view toggle.
function pickerFixture(visibility: "missing" | "false" | "true" | "hidden" | "duplicate") {
  const attribute = visibility === "missing" || visibility === "duplicate" ? "" : visibility === "hidden" ? " hidden" : ` aria-hidden="${visibility}"`;
  const trigger = `<div role="menuitem" data-model-picker-view-toggle="true"${attribute}>Select model</div>`;
  const document = createDocument(`<div role="menu"><div data-model-picker-view="simple">${trigger}${visibility === "duplicate" ? trigger : ""}
    <div hidden><div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
  </div></div>`);
  let toggles = 0;
  let selections = 0;
  const wrap = (nodes: Element[]): any => ({
    count: async () => nodes.length,
    getAttribute: async (name: string) => nodes[0]?.getAttribute(name),
    locator: (selector: string) => wrap(nodes.flatMap(node => Array.from(node.querySelectorAll(selector)))),
    filter: ({ visible }: { visible: boolean }) => wrap(nodes.filter(node => !visible || !node.closest("[hidden]"))),
    getByRole: (role: string, { name }: { name: RegExp }) => wrap(nodes.flatMap(node =>
      Array.from(node.querySelectorAll(`[role="${role}"]`)).filter(child => name.test(child.textContent!.trim())))),
    waitFor: async () => { if (!nodes[0] || nodes[0].closest("[hidden]")) throw new Error("Radio remains hidden"); },
    click: async () => {
      if (nodes.length !== 1) throw new Error("Ambiguous fixture click");
      const node = nodes[0]!;
      if (node.hasAttribute("data-model-picker-view-toggle")) {
        toggles++;
        document.querySelector("[data-model-picker-view]")!.setAttribute("data-model-picker-view", "advanced");
        document.querySelector("[hidden]")!.removeAttribute("hidden");
      } else { selections++; node.setAttribute("aria-checked", "true"); }
    },
  });
  const menu = { menu: wrap([document.querySelector('[role="menu"]')!]) } as Parameters<typeof selectChatGptModelFamily>[0];
  return { menu, counts: () => ({ toggles, selections }) };
}

for (const visibility of ["missing", "false"] as const) {
  test(`family selection opens the owned visible picker toggle with aria-hidden ${visibility}`, async () => {
    const fixture = pickerFixture(visibility);
    expect(await selectChatGptModelFamily(fixture.menu, "5.6", async () => fixture.menu)).toBe(fixture.menu);
    expect(fixture.counts()).toEqual({ toggles: 1, selections: 1 });
  });
}

for (const visibility of ["true", "hidden", "duplicate"] as const) {
  test(`family selection rejects a ${visibility} picker toggle without selecting a model`, async () => {
    const fixture = pickerFixture(visibility);
    await expect(selectChatGptModelFamily(fixture.menu, "5.6", async () => fixture.menu)).rejects.toThrow("could not be selected and verified");
    expect(fixture.counts()).toEqual({ toggles: 0, selections: 0 });
  });
}

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["Le plus récent", true], ["最新", true], ["最新模型", true], ["최신", true], ["GPT-6 Pro", true], ["GPT-6", true], ["6", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false], ["最新模型預覽", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation verifies the exact Sol or Pro version, including the old Latest picker", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Medium, 2 of 3.", "Medium"], "6", "medium")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6.1 High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});

test("explicit GPT-6 verifies every non-Pro effort without accepting the older 5.6 family", () => {
  for (const [effort, label] of [["low", "Instant"], ["medium", "中"], ["high", "High"], ["xhigh", "極高"]] as const) {
    expect(chatGptModelFamilyMatches([`6 ${label}, 3 of 5.`], "6", effort)).toBe(true);
    expect(chatGptModelFamilyMatches([`5.6 ${label}, 3 of 5.`], "6", effort)).toBe(false);
  }
});

test("model verification accepts Unicode announcement punctuation without weakening identity", () => {
  for (const separator of ["、", "，", "،", "؛", "：", "—", "。", ",", ";"]) {
    expect(chatGptModelFamilyMatches([`6 Pro${separator}5 件中 5 番目。`], "6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`GPT-5.6 Sol Pro${separator}translated position`], "5.6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.1 Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Sol Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Pro${separator}position`, "5.6 Pro"], "6", "max")).toBeFalse();
  }
  expect(chatGptModelFamilyMatches(["\u2068６ Pro\u2069、position"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro for better answers"], "6", "max")).toBeFalse();
});
