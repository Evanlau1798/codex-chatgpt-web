import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test("pre-send model failures identify the rejected proof without logging private surface content", async () => {
  const original = { url: "https://chatgpt.com/c/private-conversation", label: "private-model-label",
    expanded: "false", editable: true, count: 1 };
  const state = { ...original };
  const control = { innerText: async () => state.label, getAttribute: async () => state.expanded };
  const controls = { filter() { return this; }, count: async () => state.count, first: () => control };
  const composer = { locator: () => ({ locator: () => controls }), isEditable: async () => state.editable };
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer });
  const page = { url: () => state.url };
  const mode = { selection: { url: original.url, label: original.label } };
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await worker.assertSelectedEffort(page, mode);
    expect(warning).not.toHaveBeenCalled();
    for (const [change, proof] of [
      [{ url: "https://chatgpt.com/c/another-private-conversation" }, { phase: "surface", urlMatches: false, controlCount: null }],
      [{ count: 2 }, { phase: "surface", urlMatches: true, controlCount: 2 }],
      [{ label: "another-private-label" }, { phase: "selection", labelMatches: false, expandedClosed: true, composerEditable: true }],
      [{ expanded: "true" }, { phase: "selection", labelMatches: true, expandedClosed: false, composerEditable: true }],
      [{ editable: false }, { phase: "selection", labelMatches: true, expandedClosed: true, composerEditable: false }],
    ] as const) {
      Object.assign(state, original, change);
      warning.mockClear();
      await expect(worker.assertSelectedEffort(page, mode, true, "diagnostic_trace")).rejects.toMatchObject({ code: "upstream_server_error", retryable: false });
      expect(warning).toHaveBeenCalledTimes(1);
      const line = String(warning.mock.calls[0]![0]);
      expect(JSON.parse(line.split(" selected_effort_failure=")[1]!)).toMatchObject({ traceId: "diagnostic_trace", ...proof });
      expect(line).not.toMatch(/private|https:|turn_token|prompt/);
    }
  } finally { warning.mockRestore(); }
});

for (const familyProven of [true, false]) {
  test(`family menu close failures remain observable with original error identity (family proven: ${familyProven})`, async () => {
    let opened = false, closes = 0;
    const control = { innerText: async () => "極高", click: async () => { opened = true; },
      getAttribute: async (name: string) => name === "aria-expanded" ? String(opened)
        : name === "data-state" ? (opened ? "open" : "closed") : "owned-effort" };
    const slider: any = { getAttribute: async (name: string) => name === "aria-valuemin" ? "0"
      : name === "aria-valuemax" ? "4" : "3",
      locator: () => ({ evaluate: async () => ["5.6 Extra High, 4 of 5."] }) };
    const menu: any = { filter: () => menu, isVisible: async () => opened, locator: () => slider,
      getByRole: () => ({ count: async () => 1, getAttribute: async () => String(familyProven) }) };
    const controls: any = { filter: () => controls, count: async () => 1, first: () => control };
    const composer = { locator: () => ({ locator: () => controls }), isEditable: async () => true };
    const failure = new ChatGptWebAdapterError("ChatGPT model controls are unavailable", {
      status: 502, code: "upstream_server_error", errorType: "server_error", retryable: false,
      cause: new Error("original menu close diagnostic"),
    });
    const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      activeComposer: async () => composer, closeEffortMenu: async () => { closes++; throw failure; },
    });
    const page = { url: () => "https://chatgpt.com/c/private-conversation", locator: () => menu };
    const mode = { modelFamily: "5.6", effort: "xhigh", uiEffortIndex: 3,
      selection: { url: page.url(), label: "極高" } };
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(worker.assertSelectedEffort(page, mode, true, "family_trace")).rejects.toBe(failure);
      expect(closes).toBe(1);
      expect(warning).toHaveBeenCalledTimes(1);
      const line = String(warning.mock.calls[0]![0]);
      expect(JSON.parse(line.split(" selected_effort_failure=")[1]!)).toEqual({ traceId: "family_trace", phase: "family-close" });
      expect(line).not.toMatch(/private|https:|極高|original menu/);
    } finally { warning.mockRestore(); }
  });
}
