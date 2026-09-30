import { expect, test } from "bun:test";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { pasteChatGptComposerLiteralText } from "../src/adapters/chatgpt-web/composer-literal-paste";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

// Retired boundary marker selection/restoration, recount and exact-marker diagnostics.
// Replacements exercise literal boundaries, independent prefix integrity, rejected paste
// privacy and no retry after dispatch. There is no restoration algorithm to emulate.
for (const boundary of ["\n", "\n\n", " ", "  ", "\t", "\r\n", "\u00a0"]) {
  test(`bounded paste preserves boundary whitespace ${JSON.stringify(boundary)}`, async () => {
    const prompt = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 2) + boundary + "tail";
    const editor = literalPasteComposer();
    await editor.run(prompt);
    expect(editor.read()).toBe(prompt);
    expect(editor.pastes.join("")).toBe(prompt);
    expect(editor.pastes).toHaveLength(2);
    expect(editor.pastes.every(value => value.length <= CHATGPT_LITERAL_PASTE_CHUNK_CHARS)).toBeTrue();
  });
}

test("single-line Markdown density does not create per-delimiter edits, even across remounts", async () => {
  const pattern = '`json` {"key": ["*value*", "~x~", "a_b=c", "call()"]} ';
  const prompt = pattern.repeat(Math.ceil((CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1) / pattern.length));
  const editor = literalPasteComposer({ onPaste: () => editor.remount() });
  await editor.run(prompt);
  expect(editor.read()).toBe(prompt);
  expect(editor.pastes).toHaveLength(3);
  expect(editor.pastes.length).toBeLessThan(20);
  expect(editor.snapshots.at(-1)).toMatchObject({
    nativeEditAttempts: editor.pastes.length, nativeEditAccepted: editor.pastes.length,
    restorationBatches: 0, remainingMarkers: 0,
  });
});

for (const selection of [{ outside: true }, { collapsed: false }, { activeOutside: true }]) {
  test(`public paste rejects invalid active selection ${JSON.stringify(selection)} before dispatch`, async () => {
    const editor = literalPasteComposer();
    editor.setSelection(selection);
    await expect(editor.withGlobals(() => pasteChatGptComposerLiteralText(editor.composer, "private value")))
      .rejects.toMatchObject({ code: "chatgpt_surface_changed", retireSession: true });
    expect(editor.pastes).toEqual([]);
    expect(editor.read()).toBe("");
  });
}

test("lost caret is recovered once before dispatch; content is pasted once", async () => {
  const editor = literalPasteComposer();
  editor.setSelection({ outside: true });
  await editor.run("literal *fixture*");
  expect(editor.pastes).toEqual(["literal *fixture*"]);
  expect(editor.read()).toBe("literal *fixture*");
  expect(editor.reanchors).toBe(2); // recovery followed by final logical-end anchor
  expect(editor.snapshots.at(-1)).toMatchObject({
    nativeEditAttempts: 1, nativeEditAccepted: 1, editEvaluationsStarted: 2, editEvaluationsSettled: 2,
  });
});

test("a second invalid selection fails closed without an unbounded caret retry", async () => {
  const editor = literalPasteComposer();
  editor.setSelection({ outside: true });
  let recoveries = 0;
  await expect(editor.run("literal", {
    reanchor: async () => { recoveries += 1; },
  })).rejects.toThrow("rejected");
  expect(recoveries).toBe(1);
  expect(editor.pastes).toEqual([]);
});

test("handled paste is not integrity evidence when the editor silently drops a delimiter", async () => {
  const editor = literalPasteComposer({ onPaste: () => editor.setText("private-sentinel\n") });
  await expect(editor.run("*private-sentinel*\n" + "tail".repeat(Math.ceil(CHATGPT_LITERAL_PASTE_CHUNK_CHARS / 4)))).rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.reanchors).toBe(0);
  expect(editor.snapshots.at(-1)!.verifiedUtf16Units).toBe(0);
});

test("rejected paste reports content-free failure and is never retried as a caret issue", async () => {
  const editor = literalPasteComposer({ acceptPaste: false });
  const failure = await editor.run("*private-sentinel*\n").catch(error => error as Error);
  if (!(failure instanceof Error)) throw new Error("Expected editor rejection");
  expect(failure.message).toContain("literal plain-text paste");
  expect(failure.message).not.toContain("private-sentinel");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.reanchors).toBe(0);
});

test("paste preserves multiline PUA text, literal word joiners and the selected connector pill", async () => {
  const prompt = " \n\uE000 literal *bold* [value])\n\uF8FF \u2060";
  const editor = literalPasteComposer({ connector: true });
  const pill = editor.element.querySelector('[data-id="plugin:test"]');
  await editor.run(prompt, { connectorSelected: true });
  expect(editor.read()).toBe(prompt);
  expect(editor.pastes).toEqual([prompt]);
  expect(editor.element.querySelector('[data-id="plugin:test"]')).toBe(pill);
  expect(pill!.textContent).toBe("Codex Native2");
});

test("a surrogate pair straddling the native paste boundary stays in one transaction", async () => {
  const prompt = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1) + "😀tail";
  const editor = literalPasteComposer();
  await editor.run(prompt);
  expect(editor.pastes[0]!.length).toBe(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1);
  expect(editor.pastes[1]!.startsWith("😀")).toBeTrue();
  expect(editor.read()).toBe(prompt);
});

test("trailing surrogate and delimiters require no subsequent replacement mutation", async () => {
  const editor = literalPasteComposer();
  await editor.run("*😀");
  expect(editor.pastes).toEqual(["*😀"]);
  expect(editor.read()).toBe("*😀");
});

test("asynchronous remount drift is rejected by final readback without restoring or resending", async () => {
  const prompt = "\uF8FF literal *tail*";
  const editor = literalPasteComposer();
  await expect(editor.run(prompt, {
    verify: async expected => {
      await editor.verify(expected);
      if (expected === prompt) setTimeout(() => { editor.remount(); editor.setText("changed"); }, 0);
    },
  })).rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toEqual([prompt]);
  expect(editor.reanchors).toBe(0);
});

test("cancellation during paste stops before prefix readback or any following transaction", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stopped", "AbortError");
  const editor = literalPasteComposer({ onPaste: () => controller.abort(reason) });
  await expect(editor.run("*value*\n" + "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS + 1), { signal: controller.signal })).rejects.toBe(reason);
  expect(editor.pastes).toHaveLength(1);
  expect(editor.verified).toEqual([""]);
  expect(editor.reanchors).toBe(0);
});

test("single-space loss at a following paste boundary fails closed without another edit", async () => {
  const editor = literalPasteComposer({
    onPaste: (_value, index) => {
      if (index === 2) editor.element.querySelectorAll("span")[1]!.firstChild!.textContent = "tail";
    },
  });
  const prompt = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS) + " tail" + "y".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS);
  await expect(editor.run(prompt)).rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toHaveLength(2);
  expect(editor.reanchors).toBe(0);
});

test("editor link-pill conversion is rejected without changing the selected connector or resending", async () => {
  const prompt = "[private-label](https://example.invalid/private-target) " + "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1);
  const editor = literalPasteComposer({
    connector: true,
    onPaste: () => {
      const pasted = editor.element.querySelectorAll("span")[1]!;
      const linkPill = editor.document.createElement("span");
      linkPill.setAttribute("contenteditable", "false");
      linkPill.setAttribute("data-link-pill", "true");
      linkPill.textContent = "private-label";
      pasted.replaceChild(linkPill, pasted.firstChild!);
    },
  });
  const connector = editor.element.querySelector('[data-id="plugin:test"]');
  const failure = await editor.run(prompt, { connectorSelected: true }).catch(error => error as Error);
  if (!(failure instanceof Error)) throw new Error("Expected link-pill integrity rejection");
  expect(failure).toMatchObject({ code: "chatgpt_prompt_integrity_mismatch", retryable: false, retireSession: true });
  expect(failure.message).not.toContain("private-label");
  expect(failure.message).not.toContain("private-target");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.element.querySelector('[data-id="plugin:test"]')).toBe(connector);
  expect(editor.reanchors).toBe(0);
  const rejectedDom = editor.element.innerHTML;
  await Bun.sleep(0);
  expect(editor.element.innerHTML).toBe(rejectedDom);
  expect(editor.pastes).toHaveLength(1);
});

test("editor attachment conversion cannot satisfy exact readback or start another transaction", async () => {
  const prompt = "private-body ".repeat(Math.ceil((CHATGPT_LITERAL_PASTE_CHUNK_CHARS + 1) / "private-body ".length));
  const editor = literalPasteComposer({
    connector: true,
    onPaste: () => {
      const pasted = editor.element.querySelectorAll("span")[1]!;
      const attachment = editor.document.createElement("span");
      attachment.setAttribute("contenteditable", "false");
      attachment.setAttribute("data-pasted-attachment", "true");
      attachment.textContent = "pasted.txt";
      pasted.parentNode!.replaceChild(attachment, pasted);
    },
  });
  const connector = editor.element.querySelector('[data-id="plugin:test"]');
  const failure = await editor.run(prompt, { connectorSelected: true }).catch(error => error as Error);
  if (!(failure instanceof Error)) throw new Error("Expected attachment integrity rejection");
  expect(failure).toMatchObject({ code: "chatgpt_prompt_integrity_mismatch", retryable: false, retireSession: true });
  expect(failure.message).not.toContain("private-body");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.pastes[0]!.length).toBeLessThanOrEqual(CHATGPT_LITERAL_PASTE_CHUNK_CHARS);
  expect(editor.element.querySelector('[data-id="plugin:test"]')).toBe(connector);
  expect(editor.reanchors).toBe(0);
  expect(editor.snapshots.at(-1)!.verifiedUtf16Units).toBe(0);
  const rejectedDom = editor.element.innerHTML;
  await Bun.sleep(0);
  expect(editor.element.innerHTML).toBe(rejectedDom);
  expect(editor.pastes).toHaveLength(1);
});
