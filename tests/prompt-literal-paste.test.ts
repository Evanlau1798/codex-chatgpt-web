import { expect, test } from "bun:test";
import { readChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-text";
import { planChatGptPromptInsertion } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import { pasteChatGptComposerLiteralText } from "../src/adapters/chatgpt-web/composer-literal-paste";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

for (const platform of ["darwin", "win32", "linux"] as const) {
  test(`public plain paste uses the platform Mod key on ${platform} and clears it after rejection`, async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: platform });
    try {
      for (const accepted of [true, false]) {
        const editor = literalPasteComposer({ platform, requirePlainPaste: true, acceptPaste: accepted });
        const text = "**literal** `code`\n";
        if (accepted) await editor.run(text);
        else await expect(editor.run(text)).rejects.toThrow("rejected");
        const key = editor.events.find(event => event.type === "keydown")!;
        expect(key.ctrlKey).toBe(platform !== "darwin");
        expect(key.metaKey).toBe(platform === "darwin");
        expect(editor.events.find(event => event.type === "paste")?.plainPaste).toBeTrue();
        expect(editor.modifierCleared).toBeTrue();
        if (accepted) expect(editor.read()).toBe(text);
      }
    } finally { Object.defineProperty(process, "platform", original); }
  });
}

test("a 100K harness uses one bounded native paste instead of repeated editor reparses", async () => {
  const prompt = ("Harness **[literal](url)**\n").repeat(4000);
  const editor = literalPasteComposer({ requirePlainPaste: true });
  await editor.run(prompt);
  expect(editor.pastes).toEqual([prompt]);
  expect(editor.read()).toBe(prompt);
  expect(editor.modifierCleared).toBeTrue();
});

test("reanchoring after a literal trailing LF keeps the next edit after that boundary", async () => {
  const editor = literalPasteComposer({ requirePlainPaste: true, connector: true });
  await editor.run(" one\n", { connectorSelected: true });
  await editor.withGlobals(() => pasteChatGptComposerLiteralText(editor.composer, "next"));
  expect(editor.read()).toBe(" one\nnext");
  expect(editor.modifierCleared).toBeTrue();
  expect(editor.element.querySelector('[data-id="plugin:test"]')!.textContent).toBe("Codex Native2");
});

test("plain paste owns its native modifier only for the editor transaction, even on rejection", async () => {
  for (const accepted of [true, false]) {
    const keys: Array<{ type: string; key: string; shiftKey: boolean }> = [];
    let plain = false;
    const element: any = { contains: () => true, dispatchEvent: (event: any) => {
      if (event.type === "keydown" || event.type === "keyup") {
        plain = event.shiftKey; keys.push({ type: event.type, key: event.key, shiftKey: plain });
        return true;
      }
      expect(plain).toBeTrue();
      expect(event.clipboardData.getData("text/plain")).toBe("**[literal](url)**\n");
      return !accepted;
    } };
    const selection = { isCollapsed: true, anchorNode: element, focusNode: element };
    const globals = { document: { activeElement: element }, window: { getSelection: () => selection },
      KeyboardEvent: class { constructor(public type: string, init: object) { Object.assign(this, init); } },
      ClipboardEvent: class { constructor(public type: string, init: object) { Object.assign(this, init); } },
      DataTransfer: class { private data = new Map(); setData(k: string, v: string) { this.data.set(k, v); } getData(k: string) { return this.data.get(k); } },
    };
    const originals = Object.fromEntries(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    Object.assign(globalThis, globals);
    try {
      const run = () => pasteChatGptComposerLiteralText({ focus: async () => {}, evaluate: async (fn: any, value: any) => fn(element, value) } as never, "**[literal](url)**\n");
      if (accepted) await run(); else await expect(run()).rejects.toThrow("rejected");
      expect(keys).toEqual([{ type: "keydown", key: "V", shiftKey: true }, { type: "keyup", key: "Shift", shiftKey: false }]);
      expect(plain).toBeFalse();
    } finally {
      for (const [key, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});

test("literal paste readback preserves inline LF, empty lines, CR and the trailing LF", () => {
  const { createDocument } = require("@mixmark-io/domino");
  const doc = createDocument('<div id="composer"><p><span data-prompt-literal-paste>  **literal**<br><br>a\r<br>b</span><span data-prompt-literal-paste><br></span><br class="ProseMirror-trailingBreak"></p></div>');
  const root = doc.getElementById("composer");
  root.querySelector("span").childNodes[3].data = "a\r";
  expect(readChatGptPromptText(root, { preserveLeading: true })).toBe("  **literal**\n\na\r\nb\n");
  expect(root.querySelectorAll("br").length).toBe(5);
});

test("literal paste readback excludes only decorations, never meaningful line breaks", () => {
  const { createDocument } = require("@mixmark-io/domino");
  const doc = createDocument('<div id="composer"><p><span app-mention-path="app://native" app-mention-display-name="Native2" contenteditable="false">Native2</span><span data-prompt-literal-paste>A<br>B</span><br class="ProseMirror-trailingBreak"></p><p><br class="ProseMirror-trailingBreak"></p><p>C</p></div>');
  expect(readChatGptPromptText(doc.getElementById("composer"), { preserveLeading: true })).toBe("A\nB\n\nC");
});

for (const units of [22, 15999, 16000, 16001, 32000, 32001, 100000, 330000]) {
  test(`one normalized insertion route at ${units} units, regardless of old flags`, () => {
    const text = "x".repeat(units);
    for (const options of [undefined, {}, { candidatePlainText: true }, { largeStructuredDirect: true }, { forceStructuredDirect: true }]) {
      expect(planChatGptPromptInsertion(text, options).strategy).toBe("literal-paste");
    }
  });
}

test("a short fresh harness is attached once as literal text without marker replacements", async () => {
  const prompt = 'Harness\n{"system":["`code` *literal*"],"messages":[]}\nturn_token turn_current';
  const inputs: unknown[] = [];
  const verified: string[] = [];
  await insertChatGptPromptText(prompt, undefined, {
    composer: async () => ({ focus: async () => {}, evaluate: async (_fn: unknown, input: { text: string }) => {
      inputs.push(input.text); return { result: true, attempts: 1, accepted: 1 };
    } }) as never,
    verify: async text => { verified.push(text); },
    reanchor: async () => {},
  });
  expect(inputs).toEqual([prompt]);
  expect(verified).toEqual(["", prompt, prompt]);
});
