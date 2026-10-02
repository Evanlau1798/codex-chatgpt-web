import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nativePermissionMode, assertNativePluginReadiness, NATIVE_SHORTCUTS } from "../src/adapters/chatgpt-web/native-readiness";
import { nativeToolResultReceipt, NativeWorkflowSignals } from "../src/adapters/chatgpt-web/native-observability";
import { translateClaudeMessages } from "../src/messages/request";
import { parseRequest } from "../src/responses/parser";
import { ChatGptToolEvidenceGuard } from "../src/adapters/chatgpt-web/tool-evidence-guard";
import { chatGptSameSurfaceRecoveryPrompt } from "../src/adapters/chatgpt-web/same-surface-recovery";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ChatGptSubmissionRejectionObserver } from "../src/adapters/chatgpt-web/browser-worker";

test("permission-control values remain distinct from tool availability and provider guarantees", () => {
  expect(nativePermissionMode("Permission Choose when ChatGPT should ask for permission when using this plugin Allow all tools")).toBe("all_tools");
  expect(nativePermissionMode("Allow low-risk tools (Default)")).toBe("low_risk");
  expect(nativePermissionMode("Unknown localized value")).toBe("unknown");
  const value = { version: 1, source: "chatgpt_settings_dom", observedAt: Date.now(), permission: "all_tools",
    advertised: [...NATIVE_SHORTCUTS], missing: [], permissionPolicyMayDenyWrites: false };
  expect(() => assertNativePluginReadiness(value)).not.toThrow();
  expect(() => assertNativePluginReadiness({ ...value, advertised: [] })).toThrow();
  expect(() => assertNativePluginReadiness({ ...value, advertised: [...NATIVE_SHORTCUTS, "made_up"] })).toThrow();
});

test("recorded failing baseline survives native translation, receipt and final recovery with no inferred exit code", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/native-claude-baseline-failure.recorded.json", import.meta.url), "utf8"));
  const body = translateClaudeMessages({ model: "chatgpt-web/high", max_tokens: 1024,
    messages: [{ role: "user", content: "Run the baseline tests" },
      { role: "assistant", content: [fixture.tool] }, { role: "user", content: [fixture.result] }],
  }, new Headers()).body;
  const result = parseRequest(body).context.messages.find(m => m.role === "toolResult")!;
  expect(result.role).toBe("toolResult"); if (result.role !== "toolResult") throw new Error("missing result");
  expect(result.isError).toBeTrue();
  expect(result.content).toBe(fixture.result.content);
  expect(String(result.content)).toContain("Exit code 1");
  const receipt = nativeToolResultReceipt({ callId: result.toolCallId, wireName: result.toolName, freeform: false },
    { content: [{ type: "text", text: result.content }], isError: result.isError });
  expect(receipt).toMatchObject({ result_state: "returned", is_error: true, execution_status: "not_reported" });
  expect(receipt).not.toHaveProperty("exit_code"); // Text is preserved evidence, not a typed runner field.
  const guard = new ChatGptToolEvidenceGuard(); guard.observeToolResult(result);
  expect(guard.retryPromptForAnswer("The command was blocked by OpenAI safety policy.")).toMatchObject({ replaceCandidate: true });
  const prompt = chatGptSameSurfaceRecoveryPrompt("recorded-binding", guard.recoveryErrorEvidence());
  expect(prompt).toContain("Exit code 1");
  expect(prompt).toContain('"is_error":true');
});

test("only typed native exit fields populate the reported-exit receipt", () => {
  const request = { callId: "call", wireName: "exec_command", freeform: false };
  expect(nativeToolResultReceipt(request, { content: [], isError: true, structuredContent: { exit_code: 1 } }))
    .toMatchObject({ exit_code: 1, execution_status: "reported_exit", is_error: true });
  expect(nativeToolResultReceipt(request, { content: [], structuredContent: { exit_code: "1" } }))
    .not.toHaveProperty("exit_code");
  expect(nativeToolResultReceipt({ ...request, wireName: "unrelated_tool" }, { content: [], structuredContent: { exit_code: 1 } }))
    .not.toHaveProperty("exit_code");
  expect(nativeToolResultReceipt(request, { content: [1n] })).toMatchObject({ output_hash_unavailable: true });
});

test("recorded error replay crosses real MCP stdio/broker sockets with call binding and original content intact", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/native-claude-baseline-failure.recorded.json", import.meta.url), "utf8"));
  const root = mkdtempSync("/private/tmp/cgw-wire-replay-");
  const broker = TurnBroker.forSocket(join(root, "broker.sock"));
  const client = new Client({ name: "recorded-error-replay", version: "1" });
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec_command", description: "fixture transport", parameters: { type: "object" } }] });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", join(root, "broker.sock")], cwd: process.cwd(), stderr: "pipe" }));
    const pending = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: "recorded-result-replay" } });
    const [call] = await broker.nextToolBatch(token);
    broker.completeTool(token, call!.callId, { content: [{ type: "text", text: fixture.result.content }], isError: fixture.result.is_error });
    const returned = await pending;
    expect(returned.isError).toBeTrue();
    expect(returned.content).toEqual([{ type: "text", text: fixture.result.content }]);
    expect(returned._meta?.codex_native_result).toMatchObject({ call_id: call!.callId, wire_name: "exec_command", result_state: "returned", is_error: true });
  } finally { await client.close(); broker.revoke(token); await broker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("observed progress logs transitions without treating transport cadence as model progress", () => {
  const saved = console.info; const events: string[] = [];
  console.info = (...values) => { events.push(values.join(" ")); };
  try {
    const signals = new NativeWorkflowSignals("test_trace");
    signals.observe(true, 0); signals.observe(true, 0); signals.observe(true, 1); signals.observe(false, 0);
    expect(events).toHaveLength(3);
    expect(events[0]).toContain('"phase":"provider_running"');
    expect(events[1]).toContain('"phase":"tool_running"');
    expect(events[2]).toContain('"phase":"waiting_unobserved"');
    expect(events.every(event => event.includes('"transport_heartbeat_is_progress":false'))).toBeTrue();
  } finally { console.info = saved; }
});

test("owned HTTP rejection is terminal evidence, not a slow-generation timeout or inferred quota", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
  const observer = new ChatGptSubmissionRejectionObserver();
  observer.begin(page as never); observer.activate();
  const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
  page.emit("request", request);
  page.emit("response", { request: () => request, status: () => 403, headers: () => ({ "content-type": "text/html" }) });
  expect(await observer.failure()).toMatchObject({ code: "chatgpt_request_forbidden", retryable: false });
  expect(observer.diagnosticSummary().statuses).toEqual([403]);
  observer.dispose();
});
