import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

const capabilities = { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: true };
test("a previously verified explicit family/effort label avoids reselecting the unchanged model", async () => {
  let waits = 0;
  const control: any = {
    locator: () => control, filter: () => control, first: () => control, count: async () => 1,
    innerText: async () => "5.6 Sol 極高", getAttribute: async () => "false",
    waitFor: async () => { waits++; throw new Error("Selection path was unexpectedly entered"); },
  };
  const composer: any = { locator: () => control, isEditable: async () => true };
  const last = { ...resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", capabilities),
    modelFamily: "5.6", selection: { url: "https://chatgpt.com/c/old", label: "5.6 Sol 極高" } };
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    lastSelectedModel: last, activeComposer: async () => composer,
  });
  const absent: any = { filter: () => absent, last: () => absent, isVisible: async () => false,
    waitFor: async () => { throw new Error("No surface error"); } };
  const page = { url: () => "https://chatgpt.com/?temporary-chat=true", locator: () => absent };
  const result = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "xhigh", capabilities, undefined, false, "5.6");
  expect(result.selection).toEqual({ url: page.url(), label: last.selection.label });
  expect(result.effort).toBe("xhigh");
  expect(waits).toBe(0);
});

for (const change of ["label", "family", "effort", "expanded", "editable", "ambiguous", "tracking"] as const) {
  test(`cached model selection cannot bypass current ${change} evidence`, async () => {
    let waits = 0;
    const cachedLabel = change === "ambiguous" ? "Pro" : "5.6 Sol 極高";
    const control: any = { locator: () => control, filter: () => control, first: () => control,
      count: async () => 1, innerText: async () => change === "label" ? "5.6 Sol 高" : cachedLabel,
      getAttribute: async () => change === "expanded" ? "true" : "false",
      waitFor: async () => { waits++; throw new Error("normal selection required"); } };
    const composer: any = { locator: () => control, isEditable: async () => change !== "editable" };
    const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      lastSelectedModel: { ...resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", capabilities),
        modelFamily: "5.6", selection: { url: "old", label: cachedLabel } },
      activeComposer: async () => composer,
    });
    const absent: any = { filter: () => absent, last: () => absent, isVisible: async () => false,
      waitFor: async () => { throw new Error("No surface error"); } };
    await expect(worker.selectModelAndEffort({ url: () => "new", locator: () => absent }, CHATGPT_WEB_MODEL_ID,
      change === "effort" ? "high" : "xhigh", capabilities, undefined, change === "tracking",
      change === "family" ? "6" : "5.6")).rejects.toThrow("model controls are unavailable");
    expect(waits).toBe(1);
  });
}

test("fresh live model proof never overrides a capability lock", async () => {
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => { throw new Error("Capability validation must happen first"); },
  });
  await expect(worker.selectModelAndEffort({}, CHATGPT_WEB_MODEL_ID, "xhigh", { ...capabilities, extraHighAvailable: false }))
    .rejects.toThrow("Extra High effort is not available");
});
