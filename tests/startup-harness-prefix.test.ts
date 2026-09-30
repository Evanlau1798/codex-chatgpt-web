import { expect, test } from "bun:test";
import { chatGptStartupHarnessPrefix } from "../src/adapters/chatgpt-web/startup-harness-prefix";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { prepareChatGptWebContext } from "../src/adapters/chatgpt-web/context-bootstrap";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const prompt = (system: string[], user: string, token: string) => 'Harness\n<codex_context_json>\n'
  + JSON.stringify({ version: 3, system, messages: [{ role: "user", content: user }], tool_wire_names: ["exec"] })
  + '\n</codex_context_json>\n<codex_native_turn_binding>\n' + token + '\n</codex_native_turn_binding>';

test("production harness below the total transport budget remains inline and can be prefilled exactly", async () => {
  const system = "Exact **[harness](url)** ".repeat(3200);
  const compiled = compileChatGptWebPrompt({ modelId: "gpt-5.6-sol", stream: false,
    options: { reasoning: "high" }, context: { systemPrompt: [system],
      messages: [{ role: "user", content: "current request", timestamp: 1 }],
      tools: [{ name: "read", description: "read", parameters: {} }] } },
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "turn_01234567890123456789012345678901",
    { nativeControlConnector: true, useEnhancedOutputTunnel: true });
  let registrations = 0;
  const broker = { registerContext: async () => { registrations++; return "context_01234567890123456789012345678901"; },
    revokeContext() {} } as unknown as TurnBroker;
  const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "production_harness");
  expect(compiled.text.length).toBeGreaterThan(70_000);
  expect(compiled.text.length).toBeLessThan(compiled.bootstrapLimits!.chars);
  expect(prepared.transport).toBe("inline");
  expect(prepared.text).toBe(compiled.text);
  expect(registrations).toBe(0);
  const prefix = chatGptStartupHarnessPrefix(prepared.text)!;
  expect(prefix).toContain(JSON.stringify(system));
  expect(prefix).not.toContain("current request");
  expect(prefix).not.toContain("turn_012345");
  const editor = literalPasteComposer({ initialText: ` ${prefix}`, connector: true });
  await editor.run(` ${prepared.text}`, { connectorSelected: true, existingPrefix: ` ${prefix}` });
  expect(editor.read()).toBe(` ${compiled.text}`);
  expect(editor.pastes).toEqual([prepared.text.slice(prefix.length)]);
});

test("production 100K harness preserves the total boundary and prepares only token-free archive instructions", async () => {
  const compiled = compileChatGptWebPrompt({ modelId: "gpt-5.6-sol", stream: false,
    options: { reasoning: "high" }, context: { systemPrompt: ["Exact harness ".repeat(7600)],
      messages: [{ role: "user", content: "current request", timestamp: 1 }],
      tools: [{ name: "read", description: "read", parameters: {} }] } },
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "turn_01234567890123456789012345678901",
    { nativeControlConnector: true, useEnhancedOutputTunnel: true });
  let registrations = 0;
  const broker = { registerContext: async () => { registrations++; return "context_01234567890123456789012345678901"; },
    revokeContext() {} } as unknown as TurnBroker;
  expect(compiled.text.length).toBeGreaterThan(compiled.bootstrapLimits!.chars);
  const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "archive_harness");
  expect(prepared.transport).toBe("native2-archive");
  expect(prepared.text.length).toBeLessThanOrEqual(compiled.bootstrapLimits!.chars);
  expect(registrations).toBe(1);
  const prefix = chatGptStartupHarnessPrefix(prepared.text)!;
  expect(prefix).toBeDefined();
  expect(prefix).not.toContain("context_012345");
  expect(prefix).not.toContain("turn_012345");
  expect(prefix).not.toContain("current request");
  const editor = literalPasteComposer({ initialText: ` ${prefix}`, connector: true });
  await editor.run(` ${prepared.text}`, { connectorSelected: true, existingPrefix: ` ${prefix}` });
  expect(editor.read()).toBe(` ${prepared.text}`);
  expect(editor.pastes).toEqual([prepared.text.slice(prefix.length)]);
});

test("warm prefix contains the complete stable harness but no old request or turn binding", () => {
  const old = prompt(["system **literal**\n", 'data ,"messages": stays literal'], "old-private-user", "turn_012345678901234567890");
  const next = prompt(["system **literal**\n", 'data ,"messages": stays literal'], "new-user", "turn_098765432109876543210");
  const prefix = chatGptStartupHarnessPrefix(old)!;
  expect(prefix).toBeDefined();
  expect(old.startsWith(prefix)).toBeTrue();
  expect(next.startsWith(prefix)).toBeTrue();
  expect(prefix).not.toContain("old-private-user");
  expect(prefix).not.toContain("turn_012345678901234567890");
  expect(prefix).toContain(JSON.stringify("system **literal**\n"));
});

test("incomplete, multipart and token-bearing harnesses cannot prime a reusable prefix", () => {
  for (const text of ["no envelope", "Harness\n<codex_context_json>\n{", prompt(["turn_012345678901234567890"], "user", "new"),
    prompt(["static"], "user", "new").replace('"version":3', '"version":4')]) {
    expect(chatGptStartupHarnessPrefix(text)).toBeUndefined();
  }
});

test("archive transport caches only its static instructions before the per-turn archive token", () => {
  const full = prompt(["system"], "old-user", "turn_012345678901234567890")
    .replace('<codex_context_json>', '<codex_context_archive>\ncontext_012345678901234567890\n</codex_context_archive>\n<codex_context_json>');
  const prefix = chatGptStartupHarnessPrefix(full)!;
  expect(prefix).toBe("Harness\n");
  expect(full.startsWith(prefix)).toBeTrue();
  expect(prefix).not.toContain("context_");
  expect(prefix).not.toContain("old-user");
});

test("a verified prepared harness appends only the current suffix and preserves its connector", async () => {
  const prefix = " Harness\n";
  const full = prefix + "latest user\nturn_current";
  const editor = literalPasteComposer({ initialText: prefix, connector: true, requirePlainPaste: true });
  await editor.run(full, { connectorSelected: true, existingPrefix: prefix });
  expect(editor.read()).toBe(full);
  expect(editor.pastes).toEqual([full.slice(prefix.length)]);
  expect(editor.verified[0]).toBe(prefix);
  expect(editor.element.querySelector('[data-id="plugin:test"]')!.textContent).toBe("Codex Native2");
});

test("drifted prepared prefix fails before any native edit", async () => {
  const prefix = " Harness\n";
  const editor = literalPasteComposer({ initialText: "stale", connector: true });
  await expect(editor.run(prefix + "new", { connectorSelected: true, existingPrefix: prefix }))
    .rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toHaveLength(0);
});
