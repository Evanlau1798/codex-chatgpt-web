import { expect, test } from "bun:test";
import { translateClaudeMessages } from "../src/messages/request";

const headers = new Headers({ "x-claude-code-session-id": "session-replay" });
const guidance = "Keep reviewing without stopping";
const reminder = `<system-reminder>\nThe user sent a new message while you were working:\n${guidance}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`;

function raw(messages: Array<Record<string, unknown>>) {
  return { model: "chatgpt-web/high", max_tokens: 1024, messages };
}

test("acknowledged Claude queued-command reminders are removed from translated input", () => {
  const translated = translateClaudeMessages(raw([
    { role: "user", content: "Inspect the repository" },
    { role: "assistant", content: "I started the review" },
    { role: "user", content: reminder },
  ]), headers, (_threadId, prompt) => prompt === guidance ? 1 : 0);

  expect(JSON.stringify(translated.body.input)).not.toContain(guidance);
  expect(translated.suppressedSteeringReplays).toBe(1);
});

test("Claude queued-command reminders remain when immediate delivery was not acknowledged", () => {
  const translated = translateClaudeMessages(raw([
    { role: "user", content: "Inspect the repository" },
    { role: "user", content: reminder },
  ]), headers, () => 0);

  expect(JSON.stringify(translated.body.input)).toContain(guidance);
  expect(translated.suppressedSteeringReplays).toBe(0);
});

test("Claude queued-command replay suppression is occurrence-counted and exact", () => {
  const unrelated = "<system-reminder>Do not remove this project instruction.</system-reminder>";
  const translated = translateClaudeMessages(raw([
    { role: "user", content: "Inspect the repository" },
    { role: "user", content: reminder },
    { role: "user", content: reminder },
    { role: "user", content: unrelated },
  ]), headers, (_threadId, prompt) => prompt === guidance ? 1 : 0);
  const input = JSON.stringify(translated.body.input);

  expect(input.match(new RegExp(guidance, "g"))).toHaveLength(1);
  expect(input).toContain(unrelated);
  expect(translated.suppressedSteeringReplays).toBe(1);
});

test("Claude queued-command replay keeps the original prompt line endings for fingerprinting", () => {
  const crlfGuidance = "First constraint\r\nSecond constraint";
  const crlfReminder = `<system-reminder>\nThe user sent a new message while you were working:\n${crlfGuidance}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`;
  const translated = translateClaudeMessages(raw([
    { role: "user", content: "Inspect the repository" },
    { role: "user", content: crlfReminder },
  ]), headers, (_threadId, prompt) => prompt === crlfGuidance ? 1 : 0);

  expect(JSON.stringify(translated.body.input)).not.toContain("First constraint");
  expect(translated.suppressedSteeringReplays).toBe(1);
});

test("Claude queued-command replay supports CRLF, multiline prompts, and revised control tails", () => {
  const prompt = "First paragraph\r\n\r\nSecond paragraph";
  const revised = `<system-reminder>\r\nThe user sent a new message while you were working:\r\n${prompt}\r\n\r\nIMPORTANT: The user message above arrived during the current task.\r\n\r\nAddress it without losing the current work.\r\n</system-reminder>`;
  const translated = translateClaudeMessages(raw([
    { role: "user", content: "Inspect the repository" },
    { role: "user", content: revised },
  ]), headers, (_threadId, instruction) => instruction === prompt ? 1 : 0);

  expect(JSON.stringify(translated.body.input)).not.toContain("First paragraph");
  expect(translated.suppressedSteeringReplays).toBe(1);
});

test("Claude replay leaves near-miss, incomplete, and unmatched reminders untouched", () => {
  const nearMiss = reminder.replace("The user sent", "A user sent");
  const incomplete = reminder.replace("\n</system-reminder>", "");
  const translated = translateClaudeMessages(raw([
    { role: "user", content: "Inspect the repository" },
    { role: "user", content: nearMiss },
    { role: "user", content: incomplete },
    { role: "user", content: reminder },
  ]), headers, () => 0);
  const input = JSON.stringify(translated.body.input);
  const texts = (translated.body.input as Array<Record<string, any>>)
    .flatMap(item => Array.isArray(item.content) ? item.content.map((part: Record<string, unknown>) => part.text) : []);

  expect(input).toContain("A user sent a new message while you were working:");
  expect(texts).toContain(incomplete);
  expect(input.match(new RegExp(guidance, "g"))).toHaveLength(3);
  expect(translated.suppressedSteeringReplays).toBe(0);
});
