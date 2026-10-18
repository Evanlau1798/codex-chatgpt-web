import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_THINK_BUTTON_SELECTOR } from "../src/chatgpt-session";

function fixture() {
  const state = { pressed: false, controlPresent: true, controlCount: 1,
    draft: "", connectors: [] as string[], loseConnector: false,
    commands: [] as string[], clicks: 0, enters: 0, pollsBeforeToggle: 0, pendingToggle: false };
  const control = { click: async () => {
    state.clicks += 1;
    if (state.pollsBeforeToggle > 0) state.pendingToggle = true;
    else state.pressed = !state.pressed;
    if (state.loseConnector) state.connectors = [];
  }, getAttribute: async () => {
    if (state.pendingToggle && state.pollsBeforeToggle-- <= 0) {
      state.pressed = !state.pressed;
      state.pendingToggle = false;
    }
    return state.pressed ? "true" : "false";
  }, waitFor: async () => { state.controlPresent = true; } };
  const controls = { count: async () => state.controlPresent ? state.controlCount : 0, first: () => control,
    or() { return this; }, filter() { return this; } };
  const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
  const page = { locator: () => absentDialog,
    keyboard: { press: async () => {} } };
  const composer = {
    filter: () => composer, first: () => composer, locator: () => composerForm, page: () => page,
    evaluate: async () => ({ text: state.draft.trim(), connectors: [...state.connectors] }),
    focus: async () => {},
    fill: async (text: string) => { state.draft = text; state.connectors = []; },
    pressSequentially: async (text: string) => { state.commands.push(text); state.draft += text; },
    press: async (key: string) => {
      if (key === "Enter") state.enters += 1;
    },
  };
  const composerForm = { getByRole: () => controls, locator: (selector: string) =>
    selector === CHATGPT_THINK_BUTTON_SELECTOR ? controls : composer, page: () => page };
  return { state, composer, composerForm, page };
}

test("Think toggle changes only when needed and preserves selected connectors", async () => {
  const ui = fixture();
  ui.state.connectors = ["Codex Native2"];
  await setChatGptThinkMode(ui.composer as never, true);
  expect(ui.state.pressed).toBeTrue();
  expect(ui.state.clicks).toBe(1);
  expect(ui.state.commands).toEqual([]);
  expect(ui.state.connectors).toEqual(["Codex Native2"]);
  await setChatGptThinkMode(ui.composer as never, true);
  await setChatGptThinkMode(ui.composer as never, false);
  expect(ui.state.pressed).toBeFalse();
  expect(ui.state.clicks).toBe(2);
  expect(ui.state.commands).toEqual([]);
});

test("Think waits for a mounted control and rejects ambiguous buttons without typing or submitting", async () => {
  const ui = fixture();
  ui.state.controlPresent = false;
  await setChatGptThinkMode(ui.composer as never, true);
  expect(ui.state.pressed).toBeTrue();
  expect(ui.state.commands).toEqual([]);
  expect(ui.state.enters).toBe(0);
  const ambiguous = fixture();
  ambiguous.state.controlCount = 2;
  await expect(setChatGptThinkMode(ambiguous.composer as never, true)).rejects.toThrow("exposed 2 visible Think controls");
  expect(ambiguous.state.enters).toBe(0);
  expect(ambiguous.state.commands).toEqual([]);
  expect(ambiguous.state.clicks).toBe(0);
});

test("Think polling removes each abort listener after its timer settles", async () => {
  const ui = fixture();
  ui.state.pollsBeforeToggle = 2;
  const listeners = { added: 0, removed: 0 };
  const signal = {
    aborted: false,
    addEventListener: () => { listeners.added += 1; },
    removeEventListener: () => { listeners.removed += 1; },
  } as unknown as AbortSignal;
  await setChatGptThinkMode(ui.composer as never, true, undefined, signal);
  expect(listeners.added).toBeGreaterThan(0);
  expect(listeners.removed).toBe(listeners.added);
});

test("Think attachment rolls back if enabling Think removes the connector and never inserts the prompt", async () => {
  const attach = (ChatGptBrowserWorker.prototype as unknown as { attachPrompt: (...args: unknown[]) => Promise<void> }).attachPrompt;
  const ui = fixture();
  const submitted: boolean[] = [];
  let cleanup = 0;
  const worker = {
    activeComposer: async () => ui.composer,
    selectConnector: async () => { ui.state.connectors = ["Codex Native2"]; return ui.composer; },
    insertPromptText: async () => { submitted.push(ui.state.pressed); },
    assertPromptAttached: async () => {},
    clearChatGptComposerState: async () => { cleanup += 1; ui.state.draft = ""; ui.state.connectors = []; },
  };
  await attach.call(worker, ui.page, "requested task", true, undefined, undefined, false, undefined, true);
  expect(submitted).toEqual([true]);

  const lost = fixture();
  lost.state.loseConnector = true;
  const failingWorker = { ...worker, activeComposer: async () => lost.composer, selectConnector: async () => {
    lost.state.connectors = ["Codex Native2"];
    lost.state.pressed = false;
    return lost.composer;
  }, insertPromptText: async () => { throw new Error("prompt must not be inserted"); },
    clearChatGptComposerState: async () => { cleanup++; lost.state.draft = ""; lost.state.connectors = []; } };
  await expect(attach.call(
    failingWorker, lost.page, "must not be inserted", true, undefined, undefined, false, undefined, true,
  )).rejects.toThrow("did not preserve the empty draft and selected connectors");
  expect(cleanup).toBe(1);
  expect(lost.state.connectors).toEqual([]);
  expect(lost.state.draft).toBe("");
});

test("Think attachment preserves the plugin on first and follow-up messages and supports Browser-only turns", async () => {
  const attach = (ChatGptBrowserWorker.prototype as unknown as { attachPrompt: (...args: unknown[]) => Promise<void> }).attachPrompt;
  for (const localTools of [true, false]) {
    const ui = fixture();
    let selections = 0;
    const submitted: boolean[] = [];
    const worker = {
      activeComposer: async () => ui.composer,
      selectConnector: async () => { selections++; ui.state.connectors = ["Codex Native2"]; return ui.composer; },
      insertPromptText: async () => { submitted.push(ui.state.pressed); }, assertPromptAttached: async () => {},
      clearChatGptComposerState: async () => { ui.state.draft = ""; ui.state.connectors = []; },
    };
    await attach.call(worker, ui.page, "requested task", localTools, undefined, undefined, false, undefined, true);
    expect(submitted).toEqual([true]);
    expect(selections).toBe(localTools ? 1 : 0);
    if (localTools) expect(ui.state.connectors).toEqual(["Codex Native2"]);
    ui.state.pressed = false;
    ui.state.connectors = [];
    await attach.call(worker, ui.page, "follow-up task", localTools, undefined, undefined, false, undefined, true);
    expect(submitted).toEqual([true, true]);
    expect(ui.state.clicks).toBe(2);
    expect(ui.state.commands).toEqual([]);
    expect(selections).toBe(localTools ? 2 : 0);
  }
});
