import { expect, test } from "bun:test";
import { structuredCompactionHandoffInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { markdownRestorationProbeText, structuredMarkdownRestorationProbeText } from "../scripts/lifecycle-smoke/markdown-restoration-probe";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

// Retired direct-text/direct-HTML/escaped fragment and empty-paragraph cleanup assertions:
// the replacements below prove exact public paste readback, bounded edits and literal HTML.
// Marker edit/batch counters are replaced by one accepted transaction per native paste.
const freshHistory = (
  "<codex_context_json>\r\n"
  + '{"history":"user *literal* [link](target) `code`, tab:\\t, nbsp:\u00a0, pua:\uE000, emoji:\u{1F680}"}\r\n'
  + "</codex_context_json>\r\n"
).repeat(450);
const compactSourceBlock = (
  "<compact_task>Summarize this exact long source; do not continue the conversation.</compact_task>\n"
  + "## Historical turn\n- keep *constraints*\n- preserve `paths` and [evidence](local)\n"
);
const compactSource = compactSourceBlock.repeat(Math.ceil((CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1) / compactSourceBlock.length));

test("REG-04: short generated structured compaction uses one exact literal paste", async () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "control-token-0123456789abcdef", handoffId: "handoff-id-0123456789abcdef",
  });
  expect(prompt.length).toBeLessThan(CHATGPT_LITERAL_PASTE_CHUNK_CHARS);
  expect(prompt.match(/[`*_#]/g)!.length).toBeGreaterThan(10);
  const editor = literalPasteComposer();
  await editor.run(prompt, { options: { forceStructuredDirect: true } });
  expect(editor.read()).toBe(prompt);
  expect(editor.pastes).toEqual([prompt]);
  expect(editor.verified).toEqual(["", prompt]);
});

test("structured compaction requests one control handoff instead of an ordinary recovery checkpoint", () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "control-token-0123456789abcdef", handoffId: "handoff-id-0123456789abcdef",
  });
  expect(prompt).toContain("This is the normal context handoff, not a No Context Window recovery checkpoint.");
  expect(prompt).toContain("Do not render the context summary as ordinary assistant text.");
  expect(prompt).toContain('"summary":"<complete context summary>"');
  expect(prompt).not.toContain("<complete checkpoint summary>");
});

for (const [name, prompt] of [
  ["incident-sized multiline structured prompt", structuredMarkdownRestorationProbeText()],
  ["incident-sized single-line Markdown", markdownRestorationProbeText()],
  ["fresh no-TTL full history", freshHistory],
  ["compact long source", compactSource],
  ["literal HTML/entities and empty lines", "prefix\n" + (
    '  literal\t\u00a0\uE000 😀 <img src=x onerror="throw 1"> &amp; &#13; <!--comment-->\n\n'
    + "</div><script>throw 1</script>\u2028line\u2029next\n"
  ).repeat(400) + "\n\n"],
  ["single-line HTML-like content", '<script>throw 1</script> &amp; <img src=x onerror="throw 1"> '.repeat(700)],
  ["oversized NUL/LF", "prefix\nA\u0000B" + "literal ".repeat(5000)],
  ["leading whitespace and trailing LF", " \t\n\uFEFF\u2028\u2029" + "body *literal*\n".repeat(1500) + "\n\n"],
  ["control/PUA/Unicode/lone surrogate", "\r\n\0\u0001\uE000\uF8FF\u2060👩‍💻e\u0301\uD800\uDC00"],
] as const) {
  test(`preserves ${name} with bounded public paste transactions`, async () => {
    const editor = literalPasteComposer();
    await editor.run(prompt, { options: { largeStructuredDirect: true } });
    expect(editor.read()).toBe(prompt);
    expect(editor.pastes.join("")).toBe(prompt);
    expect(editor.pastes.every(value => value.length <= CHATGPT_LITERAL_PASTE_CHUNK_CHARS)).toBeTrue();
    expect(editor.verified[0]).toBe("");
    expect(editor.verified.slice(1, -1)).toEqual(editor.pastes.slice(0, -1).map((_, index) => editor.pastes.slice(0, index + 1).join("")));
    expect(editor.verified.at(-1)).toBe(prompt);
    expect(editor.reanchors).toBe(1);
    expect(editor.element.querySelectorAll("img, script")).toHaveLength(0);
  });
}

test("selected connector preserves its pill while an editor removes its transient placeholder", async () => {
  const prompt = compactSource;
  const editor = literalPasteComposer({
    initialText: "\u200B", connector: true,
    onPaste: (_value, index) => { if (index === 1) editor.element.querySelector("p")!.firstChild!.nextSibling!.textContent = ""; },
  });
  await editor.run(prompt, { connectorSelected: true });
  expect(editor.read()).toBe(prompt);
  expect(editor.verified[0]).not.toBe("");
  expect(editor.element.querySelector('[data-id="plugin:test"]')!.textContent).toBe("Codex Native2");
});

test("selected connector reuses exactly one existing separator", async () => {
  const prompt = " " + compactSource;
  const editor = literalPasteComposer({ initialText: " ", connector: true });
  await editor.run(prompt, { connectorSelected: true, existingPrefix: " " });
  expect(editor.pastes.join("")).toBe(prompt.slice(1));
  expect(editor.read()).toBe(prompt);
  expect(editor.element.querySelector('[data-id="plugin:test"]')).not.toBeNull();
});

test("selected connector rejects a surviving placeholder before any following paste", async () => {
  const editor = literalPasteComposer({ initialText: "\u200B", connector: true });
  await expect(editor.run(compactSource, { connectorSelected: true })).rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.reanchors).toBe(0);
});

test("nonempty fresh composer is rejected before an editor mutation", async () => {
  const editor = literalPasteComposer({ initialText: "existing user text" });
  await expect(editor.run("new message")).rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toEqual([]);
  expect(editor.read()).toBe("existing user text");
  expect(editor.acquisitions).toBe(0);
});

test("final settled readback rejects delayed editor drift without resending", async () => {
  const prompt = "short *literal* fixture";
  const editor = literalPasteComposer({ onPaste: () => {
    setTimeout(() => editor.setText(prompt.slice(0, -1) + "!"), 0);
  } });
  await expect(editor.run(prompt)).rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toEqual([prompt]);
  expect(editor.verified).toEqual(["", prompt]);
  expect(editor.reanchors).toBe(0);
});

test("cancelled native paste settles and never starts another paste or final caret action", async () => {
  const controller = new AbortController();
  const editor = literalPasteComposer({ onPaste: () => controller.abort() });
  await expect(editor.run(compactSource, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(editor.pastes).toHaveLength(1);
  expect(editor.read()).toBe(editor.pastes[0]!);
  expect(editor.verified).toEqual([""]);
  expect(editor.reanchors).toBe(0);
});

test("editor rejection is final, content-free and never switches to HTML/text", async () => {
  const editor = literalPasteComposer({ acceptPaste: false });
  const failure = await editor.run(compactSource).catch(error => error as Error);
  if (!(failure instanceof Error)) throw new Error("Expected editor rejection");
  expect(failure).toMatchObject({ code: "chatgpt_surface_changed", retireSession: true });
  expect(failure.message).toContain("literal plain-text paste");
  expect(failure.message).not.toContain("compact_task");
  expect(editor.read()).toBe("");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.reanchors).toBe(0);
  await Bun.sleep(0);
  expect(editor.pastes).toHaveLength(1);
});

test("production metrics count paste transactions without marker work or prompt content", async () => {
  const prompt = "header\n" + "*word* ".repeat(5000) + "tail";
  const editor = literalPasteComposer();
  await editor.run(prompt);
  expect(editor.snapshots.at(-1)).toMatchObject({
    event: "summary", nativeEditAttempts: editor.pastes.length, nativeEditAccepted: editor.pastes.length,
    nativeEditCountsComplete: true, restorationBatches: 0, remainingMarkers: 0,
    verifiedUtf16Units: prompt.length, insertedUtf16Units: prompt.length,
  });
  expect(JSON.stringify(editor.snapshots)).not.toContain("word");
});

test("rejected paste is counted without false inserted or verified progress", async () => {
  const editor = literalPasteComposer({ acceptPaste: false });
  await expect(editor.run("private fixture")).rejects.toThrow("rejected");
  expect(editor.snapshots.at(-1)).toMatchObject({ nativeEditAttempts: 1, nativeEditAccepted: 0,
    verifiedUtf16Units: 0, insertedUtf16Units: 0, nativeEditCountsComplete: true });
  expect(JSON.stringify(editor.snapshots)).not.toContain("private fixture");
});
