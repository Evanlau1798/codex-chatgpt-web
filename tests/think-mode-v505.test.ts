import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";

function fixture() {
  const state = { pressed: false, controlPresent: true, highlighted: true, popupCount: 1,
    optionCount: 1, draft: "", connectors: [] as string[], loseConnector: false,
    commands: [] as string[], enters: 0 };
  const control = { getAttribute: async () => state.pressed ? "true" : "false" };
  const controls = { count: async () => state.controlPresent ? 1 : 0, first: () => control };
  const row = { getAttribute: async () => state.highlighted ? "" : null,
    waitFor: async () => { if (!state.optionCount) throw new Error("Think command is unavailable"); } };
  const rows = { filter: () => rows, first: () => row, count: async () => state.optionCount };
  const popup = { filter: () => popup, locator: () => rows, count: async () => state.popupCount };
  const page = { locator: () => popup, keyboard: { press: async () => {} } };
  const composer = {
    filter: () => composer, first: () => composer, locator: () => composerForm,
    evaluate: async () => ({ text: state.draft.trim(), connectors: [...state.connectors] }),
    focus: async () => {},
    fill: async (text: string) => { state.draft = text; state.connectors = []; },
    pressSequentially: async (text: string) => { state.commands.push(text); state.draft += text; },
    press: async (key: string) => {
      if (key === "ArrowDown") state.highlighted = true;
      if (key === "Enter") {
        if (state.draft !== "/think" || !state.highlighted) throw new Error("Unexpected composer submission");
        state.enters += 1;
        state.pressed = !state.pressed;
        state.controlPresent = true;
        state.draft = "";
        if (state.loseConnector) state.connectors = [];
      }
    },
  };
  const composerForm = { getByRole: () => ({ filter: () => controls }), locator: () => composer, page: () => page };
  return { state, composer, composerForm, page };
}

test("Think slash toggles only when needed and preserves selected connectors", async () => {
  const ui = fixture();
  ui.state.connectors = ["Codex Native2"];
  await setChatGptThinkMode(ui.composerForm as never, true);
  expect(ui.state.pressed).toBeTrue();
  expect(ui.state.commands).toEqual(["/think"]);
  expect(ui.state.connectors).toEqual(["Codex Native2"]);
  await setChatGptThinkMode(ui.composerForm as never, true);
  await setChatGptThinkMode(ui.composerForm as never, false);
  expect(ui.state.pressed).toBeFalse();
  expect(ui.state.commands).toEqual(["/think", "/think"]);
});

test("Think slash verifies one command and a newly exposed pressed state", async () => {
  const ui = fixture();
  ui.state.controlPresent = false;
  await setChatGptThinkMode(ui.composerForm as never, true);
  expect(ui.state.pressed).toBeTrue();
  const ambiguous = fixture();
  ambiguous.state.optionCount = 2;
  await expect(setChatGptThinkMode(ambiguous.composerForm as never, true)).rejects.toThrow("exactly one command option");
  expect(ambiguous.state.enters).toBe(0);
});

test("Think attachment runs after connector selection and rolls back connector loss", async () => {
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
  await attach.call(worker, ui.page, "requested task", true, undefined, false, undefined, false, undefined, true);
  expect(submitted).toEqual([true]);

  const lost = fixture();
  lost.state.loseConnector = true;
  const failingWorker = { ...worker, selectConnector: async () => {
    lost.state.connectors = ["Codex Native2"];
    return lost.composer;
  }, insertPromptText: async () => { throw new Error("prompt must not be inserted"); } };
  await expect(attach.call(
    failingWorker, lost.page, "must not be inserted", true, undefined, false, undefined, false, undefined, true,
  )).rejects.toThrow("selected connectors");
  expect(cleanup).toBe(1);
});
