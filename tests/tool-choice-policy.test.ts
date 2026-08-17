import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { validateBatchTools } from "../src/adapters/chatgpt-web/steering";
import { assertChatGptToolRequirementSatisfied, effectiveChatGptToolPolicy } from "../src/adapters/chatgpt-web/tool-policy";
import type { BrokerToolRequest } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest, CodexToolChoice } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
const token = "turn_12345678901234567890123456789012";

function request(toolChoice: CodexToolChoice): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{ role: "user", content: "perform the task", timestamp: 1 }],
      tools: [
        { name: "Read", description: "Read a file", parameters: {} },
        { name: "Write", description: "Write a file", parameters: {} },
        { namespace: "mcp__repo", name: "inspect", description: "Inspect the repository", parameters: {} },
      ],
    },
    stream: true,
    options: { reasoning: "high", toolChoice },
  };
}

function toolRequest(wireName: string): BrokerToolRequest {
  return { callId: `call_${wireName}`, wireName, freeform: false, arguments: {} };
}

test("tool_choice none removes the local tool bridge from the prompt", () => {
  const compiled = compileChatGptWebPrompt(request("none"), capabilities);

  expect(compiled.turnToken).toBeUndefined();
  expect(compiled.text).not.toContain("tool_wire_names");
  expect(compiled.text).toContain("with no Codex Native bridge");
});

test("named tool_choice advertises only the selected tool and rejects other tool calls", () => {
  const parsed = request({ name: "Read" });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token);

  expect(compiled.text).toContain('\"tool_wire_names\":[\"Read\"]');
  expect(compiled.text).not.toContain('\"tool_wire_names\":[\"Read\",\"Write\"');
  expect(() => validateBatchTools(parsed, [toolRequest("Write")])).toThrow(/did not advertise/);
  expect(() => validateBatchTools(parsed, [toolRequest("Read")])).not.toThrow();
});

test("allowed_tools constrains namespaced tools and preserves required mode", () => {
  const parsed = request({ allowedTools: ["mcp__repo__inspect"], mode: "required" });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token);

  expect(compiled.text).toContain('\"tool_wire_names\":[\"mcp__repo__inspect\"]');
  expect(compiled.text).toContain("must execute at least one of the request-authorized local tools");
  expect(() => validateBatchTools(parsed, [toolRequest("Read")])).toThrow(/did not advertise/);
  expect(() => validateBatchTools(parsed, [toolRequest("mcp__repo__inspect")])).not.toThrow();
});

test("required tool policy rejects a final answer until an authorized tool result was delivered", () => {
  const policy = effectiveChatGptToolPolicy(request("required"));
  expect(() => assertChatGptToolRequirementSatisfied(policy, false)).toThrow(/required at least one request-authorized local tool execution/);
  expect(() => assertChatGptToolRequirementSatisfied(policy, true)).not.toThrow();
});

test("tool policy fails closed for unavailable required tools and ignores deferred tool-search expansion", () => {
  const missing = request({ name: "Missing" });
  expect(() => effectiveChatGptToolPolicy(missing)).toThrow(/request-authorized local tool that is unavailable/);

  const deferred = request("auto");
  deferred.context.tools!.push({
    name: "DeferredWrite",
    description: "Dynamically discovered mutation",
    parameters: {},
    loadedFromToolSearch: true,
  });
  expect([...effectiveChatGptToolPolicy(deferred).wireNames]).not.toContain("DeferredWrite");
});
