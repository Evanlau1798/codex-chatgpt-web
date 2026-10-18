import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { assertChatGptModelFamily, chatGptModelFamilyMatches, chatGptUnversionedEffortMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

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

test("model headers may repeat the same version before their effort without hiding contradictions", async () => {
  for (const [effort, label, index] of [["low", "Instant", 0], ["medium", "Medium", 1],
    ["high", "High", 2], ["xhigh", "Extra High", 3], ["max", "Pro", 4]] as const) {
    const descriptions = [`5.6 ${label}，第 ${index + 1} 項，共 5 項。`, `5.6 Sol 5.6 ${label}`];
    expect(chatGptModelFamilyMatches(descriptions, "5.6", effort)).toBeTrue();
    await assertChatGptModelFamily(confirmationFixture("GPT-5.6 Sol", descriptions, String(index)), "5.6", effort, index);
  }
  for (const header of ["5.6 Sol 6 Extra High", "6 Sol 5.6 Extra High", "5.6 Astra 5.6 Extra High",
    "5.6 Sol 5.6 High", "5.6 Sol 5.6 Extra High, 3 of 5.", "5.6 Sol 5.6 Extra High for better answers"]) {
    const descriptions = ["5.6 Extra High，第 4 項，共 5 項。", header];
    expect(chatGptModelFamilyMatches(descriptions, "5.6", "xhigh")).toBeFalse();
    await expect(assertChatGptModelFamily(confirmationFixture("GPT-5.6 Sol", descriptions, "3"), "5.6", "xhigh", 3))
      .rejects.toThrow("could not be selected and verified");
  }
});

test("explicit GPT-6 verifies every non-Pro effort without accepting the older 5.6 family", () => {
  for (const [index, [effort, label]] of ([["low", "Instant"], ["medium", "中"], ["high", "High"], ["xhigh", "極高"]] as const).entries()) {
    expect(chatGptModelFamilyMatches([`6 ${label}, ${index + 1} of 5.`], "6", effort)).toBe(true);
    expect(chatGptModelFamilyMatches([`5.6 ${label}, ${index + 1} of 5.`], "6", effort)).toBe(false);
  }
});

function confirmationFixture(label: string, descriptions: string[], value = "2") {
  return ({
    menu: { getByRole: (_role: string, options: { name: RegExp }) => ({
      count: async () => options.name.test(label) ? 1 : 0,
      getAttribute: async () => "true", innerText: async () => label,
    }) },
    slider: { getAttribute: async (name: string) => name === "aria-valuemin" ? "0" : name === "aria-valuemax" ? "4" : value,
      evaluate: async () => descriptions },
  }) as unknown as Parameters<typeof assertChatGptModelFamily>[0];
}

test("the current explicit GPT-6 radio binds an unversioned effort announcement", async () => {
  const fixture = confirmationFixture;
  await assertChatGptModelFamily(fixture("GPT-6", ["High, 3 of 5.", "High"]), "6", "high", 2);
  await assertChatGptModelFamily(fixture("GPT-6", ["High，第 3 項，共 5 項。", "High"]), "6", "high", 2);
  await assertChatGptModelFamily(fixture("GPT-6", ["高，第 3 項，共 5 項。", "高"]), "6", "high", 2);
  for (const menu of [fixture("Latest", ["High, 3 of 5."]), fixture("GPT-5.6 Sol", ["High, 3 of 5."]),
    fixture("GPT-6", ["5.6 High, 3 of 5."]), fixture("GPT-6", ["High, 3 of 5."], "1"),
    fixture("GPT-6", ["Pro, 5 of 5."]), fixture("GPT-6", ["High，第 2 項，共 5 項。"]),
    fixture("GPT-6", ["High，第 3 項，共 2 項。"])]) {
    await expect(assertChatGptModelFamily(menu, "6", "high", 2)).rejects.toThrow("could not be selected and verified");
  }
});

test("legacy Latest Pro requires versioned evidence, never generic Pro alone", async () => {
  for (const label of ["Latest", "Le plus récent", "最新", "最新模型", "최신"]) {
    await expect(assertChatGptModelFamily(confirmationFixture(label, ["Pro, 5 of 5."], "4"), "6", "max", 4))
      .rejects.toThrow("could not be selected and verified");
    await assertChatGptModelFamily(confirmationFixture(label, ["6 Pro, 5 of 5."], "4"), "6", "max", 4);
  }
  await assertChatGptModelFamily(confirmationFixture("GPT-6", ["Pro, 5 of 5."], "4"), "6", "max", 4);
});

test("versioned announcements must agree with the requested effort and announced position", async () => {
  for (const description of ["6 Medium, 2 of 5.", "6 High, 2 of 5.", "6 High，第 2 項，共 5 項。",
    "6 High, 3 of 2.", "6 Extra High, 4 of 5."]) {
    expect(chatGptModelFamilyMatches([description], "6", "high")).toBe(false);
    await expect(assertChatGptModelFamily(confirmationFixture("GPT-6", [description]), "6", "high", 2))
      .rejects.toThrow("could not be selected and verified");
  }
});

test("all recognizable effort evidence must agree across headers and status descriptions", async () => {
  for (const descriptions of [["6 High", "Medium, 2 of 5."], ["6 High", "Medium"],
    ["6 High", "High, 2 of 5."], ["6 High", "中，第 2 項，共 5 項。"],
    ["High, 3 of 5.", "Medium"], ["6 High", "High, 3 of 6."], ["6 High", "High, 3 of 0."],
    ["6 High", "Extra    High"], ["6 High", "High, 2 of 5"], ["6 High", "High、2 of 5。"],
    ["6 High", "Medium、3 of 5"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "high")).toBe(false);
    await expect(assertChatGptModelFamily(confirmationFixture("GPT-6", descriptions), "6", "high", 2))
      .rejects.toThrow("could not be selected and verified");
  }
  for (const descriptions of [["6 High", "High, 3 of 5."], ["6 High", "高，第 3 項，共 5 項。"],
    ["6 Élevé", "Élevé, 3 sur 5."], ["6 High", "High, 3 of 5"], ["6 High", "High、3 of 5。"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "high")).toBe(true);
    await assertChatGptModelFamily(confirmationFixture("GPT-6", descriptions), "6", "high", 2);
  }
});

test("unversioned fallback shares canonical Unicode normalization and rejects foreign versions", async () => {
  for (const header of ["５.６ High", "\u20685.6 High\u2069", "ＧＰＴ－５．６ Sol High", "5.\u200e6 High"]) {
    const descriptions = [header, "High, 3 of 5."];
    expect(chatGptModelFamilyMatches(descriptions, "6", "high")).toBe(false);
    expect(chatGptUnversionedEffortMatches(descriptions, "high")).toBe(false);
    await expect(assertChatGptModelFamily(confirmationFixture("GPT-6", descriptions), "6", "high", 2))
      .rejects.toThrow("could not be selected and verified");
  }
  for (const status of ["\u2068Ｈｉｇｈ，３ of ５．\u2069", "High, 3 of 5", "High、3 of 5。"])
    await assertChatGptModelFamily(confirmationFixture("GPT-6", [status, "High"]), "6", "high", 2);
});

test("a bare model header must agree with the selected family even beside a valid effort status", async () => {
  for (const header of ["5.6", "５．６", "\u20685.6\u2069", "GPT-5.6"]) {
    expect(chatGptModelFamilyMatches(["6 High", header], "6", "high")).toBe(false);
    await expect(assertChatGptModelFamily(confirmationFixture("GPT-6", [header, "High, 3 of 5."]), "6", "high", 2))
      .rejects.toThrow("could not be selected and verified");
  }
  for (const header of ["6", "６", "\u2068GPT-6\u2069"])
    await assertChatGptModelFamily(confirmationFixture("GPT-6", [header, "High, 3 of 5."]), "6", "high", 2);
});

test("foreign version prefixes remain contradictory before punctuation or adjacent text", async () => {
  for (const header of ["５．６：", "5.6,", "GPT-5.6—", "5.6、", "5.6.High", "5.6High", "6.1High"]) {
    expect(chatGptModelFamilyMatches(["6 High", header], "6", "high")).toBe(false);
    await expect(assertChatGptModelFamily(confirmationFixture("GPT-6", [header, "High, 3 of 5."]), "6", "high", 2))
      .rejects.toThrow("could not be selected and verified");
  }
  for (const header of ["６：", "GPT-6—", "6、"])
    await assertChatGptModelFamily(confirmationFixture("GPT-6", [header, "High, 3 of 5."]), "6", "high", 2);
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
