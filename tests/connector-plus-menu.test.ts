import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_CONNECTOR_MENTION_ROW_SELECTOR, chatGptConnectorMentionRowHighlighted, openChatGptConnectorPlusMenu } from "../src/adapters/chatgpt-web/connector-plus-menu";

test.each([
  [{ "data-highlighted": "" }, true],
  [{ "aria-current": "true" }, true],
  [{ "aria-current": "false" }, false],
] as const)("connector mention row accepts current UI highlight state %j", async (attributes, expected) => {
  const row = { getAttribute: async (name: string) => attributes[name as keyof typeof attributes] ?? null };
  expect(await chatGptConnectorMentionRowHighlighted(row as never)).toBe(expected);
});

test("connector mention discovery recognizes the updated navigation row", () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document };
  };
  const document = createWindow(`
    <div data-mention-list-scroll-area>
      <button data-list-navigation-item="true"><span>Codex Native2</span></button>
    </div>
  `).document;
  const rows = document.querySelectorAll(CHATGPT_CONNECTOR_MENTION_ROW_SELECTOR);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toBe("Codex Native2");
});

test("opens the connector plus menu and resolves one exact ARIA connector row", async () => {
  const calls: string[] = [];
  const row = {
    count: async () => 1,
    focus: async () => { calls.push("row:focus"); },
    waitFor: async () => { calls.push("row:visible"); },
  };
  const page = {
    locator: () => ({ filter: () => ({}) }),
    getByText: () => ({}),
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
      return { or: () => ({ filter: () => row }), filter: () => row };
    },
    keyboard: {
      press: async (key: string) => { calls.push(`key:${key}`); },
    },
  };

  expect(await openChatGptConnectorPlusMenu(page as never, "Codex Native2")).toBe(row as never);
  expect(calls).toEqual(["plus:focus", "key:Enter", "row:visible"]);
});

test("connector fallback opens the semantic add-context control when the legacy test id is absent", async () => {
  const { createWindow } = require("@mixmark-io/domino") as { createWindow(html: string): { document: Document } };
  const document = createWindow('<form><button type="button" data-composer-navigation-target="add-context" aria-label="新增檔案和更多內容"></button>'
    + '<button type="submit">Send</button></form>').document;
  const actions: string[] = [];
  const control = (selector: string) => ({ filter: () => ({
    count: async () => document.querySelectorAll(selector).length,
    focus: async () => { actions.push("focus:add-context"); },
    press: async (key: string) => { actions.push(`add-context:${key}`); },
  }) });
  const row = { count: async () => 1, waitFor: async () => {}, focus: async () => { actions.push("focus:exact-row"); } };
  const page = { getByTestId: () => control('[data-testid="composer-plus-btn"]'), locator: control,
    getByText: () => ({}), getByRole: () => ({ or: () => ({ filter: () => row }) }), keyboard: { press: async () => {} } };
  expect(await openChatGptConnectorPlusMenu(page as never, "Codex Native2")).toBe(row as never);
  expect(actions).toEqual(["focus:add-context", "add-context:Enter"]);
  document.querySelector("form")!.insertAdjacentHTML("beforeend", '<button data-composer-navigation-target="add-context"></button>');
  await expect(openChatGptConnectorPlusMenu(page as never, "Codex Native2")).rejects.toThrow("duplicate plus controls");
  expect(actions).toHaveLength(2);
});

test("connector plus menu resolves the new plugin navigation row by its exact label", async () => {
  const { createWindow } = require("@mixmark-io/domino") as { createWindow(html: string): { document: Document } };
  const document = createWindow('<button data-testid="composer-plus-btn"></button>'
    + '<button data-list-navigation-item="true" data-plugin-impression-id="app-native"><span>Codex Native2</span><span>Codex Native2</span></button>'
    + '<button data-list-navigation-item="true" data-plugin-impression-id="app-dev"><span>Codex Native2 DEV</span></button>').document;
  const actions: string[] = [];
  const locator = (nodes: Element[]): any => ({
    filter: (options: { has?: { name: string } }) => locator(options.has
      ? nodes.filter(n => Array.from(n.querySelectorAll("span")).some(s => s.textContent === options.has!.name)) : nodes),
    or: (other: { nodes: Element[] }) => locator([...new Set([...nodes, ...other.nodes])]), nodes,
    count: async () => nodes.filter(n => document.documentElement.contains(n)).length,
    focus: async () => {
      const plugin = nodes[0]!.getAttribute("data-plugin-impression-id");
      actions.push(plugin ?? "plus");
      // Live navigation menus dismiss when focus leaves their composer/trigger.
      if (plugin) nodes[0]!.remove();
    },
    press: async () => {}, waitFor: async () => { if (!nodes.length) { const error = new Error("missing"); error.name = "TimeoutError"; throw error; } },
  });
  const page = { getByTestId: () => locator([...document.querySelectorAll('[data-testid="composer-plus-btn"]')]),
    locator: (selector: string) => locator([...document.querySelectorAll(selector)]),
    getByRole: () => locator([]), getByText: (name: string, options: { exact: boolean }) => { expect(options.exact).toBeTrue(); return { name }; },
    keyboard: { press: async () => {} } };
  const row = await openChatGptConnectorPlusMenu(page as never, "Codex Native2");
  expect(row).toBeDefined();
  expect(await row!.count()).toBe(1);
  expect(actions).toEqual(["plus"]);
  document.body.insertAdjacentHTML("beforeend", '<button data-list-navigation-item="true" data-plugin-impression-id="duplicate"><span>Codex Native2</span></button>');
  await expect(openChatGptConnectorPlusMenu(page as never, "Codex Native2")).rejects.toThrow("duplicate");
  expect(actions).toEqual(["plus", "plus"]);
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
    click: async () => { calls.push("row:click"); selected = true; },
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
    getByRole: () => ({ or: () => ({ filter: () => row }), filter: () => row }),
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
    "row:click",
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
    getByRole: () => ({ or: () => ({ filter: () => row }), filter: () => row }),
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
    "plus:focus", "plus:Enter", "row:visible",
    "proof:cleanup",
  ]);
});
