import { expect, test } from "bun:test";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS } from "../src/adapters/chatgpt-web/prompt-insertion-plan";

test.each(["short *literal* prompt", "中😀`literal`\n".repeat(10_000)])("only the final paste avoids duplicate readback", async prompt => {
  const editor = literalPasteComposer();
  await editor.run(prompt);
  expect(editor.read()).toBe(prompt);
  expect(editor.verified.map(value => value.length)).toEqual([0,
    ...editor.pastes.slice(0, -1).map((_, index) => editor.pastes.slice(0, index + 1).join("").length), prompt.length]);
  expect(editor.verified.at(-1) === prompt).toBeTrue();
  expect(editor.snapshots.filter(snapshot => snapshot.phase === "final_verify" && snapshot.event === "completed")).toHaveLength(1);
});

test("post-yield final readback rejects delayed drift after the last accepted paste", async () => {
  const prompt = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS + 1);
  const editor = literalPasteComposer({ onPaste: (_value, index) => {
    if (index === 2) setTimeout(() => editor.setText(prompt + "drift"), 0);
  } });
  await expect(editor.run(prompt)).rejects.toThrow("integrity mismatch");
  expect(editor.pastes.join("")).toBe(prompt);
  expect(editor.pastes).toHaveLength(2);
  expect(editor.reanchors).toBe(0);
});
