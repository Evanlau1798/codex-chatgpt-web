import { expect, test } from "bun:test";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import {
  STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS, structuredMarkdownRestorationProbeText,
} from "../scripts/lifecycle-smoke/markdown-restoration-probe";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

// Retired right-to-left single-marker offsets, replacement-range size, 128-edit batches
// and per-batch yields. Their semantic replacements are exact structured readback,
// bounded public paste transactions, remount tolerance and zero restoration mutations.
test("structured Native2 prompt survives bounded literal pastes and editor remounts", async () => {
  const probe = structuredMarkdownRestorationProbeText();
  expect(probe).toHaveLength(STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS);
  const prompt = probe.repeat(Math.ceil((CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1) / probe.length));
  expect(prompt).toContain("```json\n");
  expect(prompt).toContain("<environment_context>\n");
  let remounts = 0;
  const editor = literalPasteComposer({ onPaste: () => { editor.remount(); remounts += 1; } });
  await editor.run(prompt);
  expect(editor.read()).toBe(prompt);
  expect(editor.pastes.join("")).toBe(prompt);
  expect(editor.pastes.every(value => value.length <= CHATGPT_LITERAL_PASTE_CHUNK_CHARS)).toBeTrue();
  expect(remounts).toBe(editor.pastes.length);
  expect(remounts).toBe(3);
  expect(editor.verified.slice(1, -1)).toEqual(editor.pastes.slice(0, -1).map((_, i) => editor.pastes.slice(0, i + 1).join("")));
  expect(editor.verified.at(-1)).toBe(prompt);
  expect(editor.snapshots.at(-1)).toMatchObject({ restorationBatches: 0, remainingMarkers: 0,
    nativeEditAttempts: editor.pastes.length, nativeEditAccepted: editor.pastes.length });
});
