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

test("production connector selection activates the exact plus-menu row", async () => {
  const calls: string[] = [];
  let selected = false;
  const plus = {
    count: async () => 1,
    focus: async () => { calls.push("plus:focus"); },
    press: async (key: string) => { calls.push(`key:${key}`); },
  };
  const row = {
    count: async () => 1,
    focus: async () => { calls.push("row:focus"); },
    waitFor: async () => { calls.push("row:visible"); },
    press: async (key: string) => {
      calls.push(`key:${key}`);
      selected = true;
    },
  };
  const selectedConnector = {
    waitFor: async () => { calls.push("selected:visible"); },
  };
  const page = {
    getByTestId: () => ({ filter: () => plus }),
    getByRole: () => ({ filter: () => row }),
    getByText: () => ({}),
    locator: () => ({ filter: () => ({}) }),
    keyboard: { press: async () => {} },
  };
  const selectedComposer = { selected: true };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  const resolved = await selectConnector.call({
    config: { appName: "Codex Native2" },
    ensureConnectorSurface: async () => {},
    activeComposer: async () => selected ? selectedComposer : { fill: async () => {} },
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
  }, page);
  expect(resolved).toBe(selectedComposer);
  expect(calls).toEqual([
    "plus:focus",
    "key:Enter",
    "row:visible",
    "row:focus",
    "key:Enter",
    "selected:visible",
  ]);
});
