import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { openChatGptConnectorPlusMenu } from "../src/adapters/chatgpt-web/connector-plus-menu";

test("opens the connector plus menu and resolves one exact ARIA connector row", async () => {
  const calls: string[] = [];
  const row = {
    count: async () => 1,
    focus: async () => { calls.push("row:focus"); },
    waitFor: async () => { calls.push("row:visible"); },
  };
  const page = {
    getByTestId: (testId: string) => {
      expect(testId).toBe("composer-plus-btn");
      return {
        filter: (options: { visible: boolean }) => {
          expect(options).toEqual({ visible: true });
          return {
            count: async () => 1,
            focus: async () => { calls.push("plus:focus"); },
            press: async (key: string) => { calls.push(`key:${key}`); },
          };
        },
      };
    },
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("menuitemradio");
      expect(options).toEqual({ name: "Codex Native2", exact: true });
      return { filter: () => row };
    },
    keyboard: {
      press: async (key: string) => { calls.push(`key:${key}`); },
    },
  };

  expect(await openChatGptConnectorPlusMenu(page as never, "Codex Native2")).toBe(row as never);
  expect(calls).toEqual(["plus:focus", "key:Enter", "row:visible", "row:focus"]);
});

test("production connector selection uses the plus menu after a conclusive mention mismatch", async () => {
  const calls: string[] = [];
  let selected = false;
  const timeout = new Error("mention menu unavailable");
  timeout.name = "TimeoutError";
  const plus = {
    count: async () => 1,
    focus: async () => { calls.push("plus:focus"); },
    press: async (key: string) => { calls.push(`plus:${key}`); },
  };
  const row = {
    count: async () => 1,
    focus: async () => { calls.push("row:focus"); },
    waitFor: async () => { calls.push("row:visible"); },
    press: async (key: string) => {
      calls.push(`row:${key}`);
      selected = true;
    },
  };
  const selectedConnector = {
    waitFor: async () => { calls.push("selected:visible"); },
  };
  const page = {
    getByTestId: () => ({ filter: () => plus }),
    getByRole: () => ({ filter: () => row }),
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => ({
      filter: (options: { visible?: boolean }) => options.visible
        ? { count: async () => 0 }
        : { waitFor: async () => { throw timeout; } },
    }),
    keyboard: { press: async () => {} },
  };
  const selectedComposer = { selected: true };
  const initialComposer = {
    fill: async () => { calls.push("mention:clear"); },
    focus: async () => { calls.push("mention:focus"); },
    pressSequentially: async () => { calls.push("mention:type"); },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  const resolved = await selectConnector.call({
    config: { appName: "Codex Native2" },
    ensureConnectorSurface: async () => {},
    activeComposer: async () => selected ? selectedComposer : initialComposer,
    clearChatGptComposerState: async () => { calls.push("mention:clear"); },
    connectorIsSelected: async () => selected,
    connectorMentionRowTitles: async () => ["Codex Native2 DEV"],
    connectorMentionFailure: async () => "DEV connector mismatch",
    selectedConnectorControl: () => selectedConnector,
  }, page);
  expect(resolved).toBe(selectedComposer);
  expect(calls).toEqual([
    "mention:clear",
    "mention:clear", "mention:focus", "mention:type",
    "mention:clear",
    "plus:focus",
    "plus:Enter",
    "row:visible",
    "row:focus",
    "row:Enter",
    "selected:visible",
  ]);
});

test("personalization proof falls back to the exact plus-menu connector after a clean mention miss", async () => {
  const calls: string[] = [];
  const timeout = new Error("mention menu unavailable");
  timeout.name = "TimeoutError";
  const composer = {
    fill: async () => { calls.push("mention:clear"); },
    focus: async () => { calls.push("mention:focus"); },
    pressSequentially: async () => { calls.push("mention:type"); },
    evaluate: async () => ({ text: "@codex", focused: true }),
  };
  const plus = {
    count: async () => 1,
    focus: async () => { calls.push("plus:focus"); },
    press: async (key: string) => { calls.push(`plus:${key}`); },
  };
  const row = {
    count: async () => 1,
    focus: async () => { calls.push("row:focus"); },
    waitFor: async () => { calls.push("row:visible"); },
  };
  const page = {
    getByTestId: () => ({ filter: () => plus }),
    getByRole: () => ({ filter: () => row }),
    getByText: () => ({}),
    locator: () => ({ filter: () => ({ waitFor: async () => { throw timeout; } }) }),
    keyboard: { press: async () => {} },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  await expect(selectConnector.call({
    config: { appName: "Codex Native2" },
    activeComposer: async () => composer,
    clearChatGptComposerState: async () => { calls.push("proof:cleanup"); },
    ensureConnectorSurface: async (
      _page: unknown,
      _capture: unknown,
      proveConnectorAccess: (signal: AbortSignal) => Promise<boolean>,
    ) => {
      expect(await proveConnectorAccess(new AbortController().signal)).toBeTrue();
      throw new Error("proof complete");
    },
  }, page)).rejects.toThrow("proof complete");
  expect(calls).toEqual([
    "mention:clear", "mention:focus", "mention:type",
    "proof:cleanup",
    "plus:focus", "plus:Enter", "row:visible", "row:focus",
    "proof:cleanup",
  ]);
});
