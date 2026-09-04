import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderAdapter } from "../adapters/base";
import { closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../adapters/chatgpt-web";
import { estimateChatGptWebInputTokens } from "../adapters/chatgpt-web/usage";
import { RemoteTurnBroker, type TurnBrokerOwner } from "../adapters/chatgpt-web/turn-broker";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
} from "../adapters/chatgpt-web/input-tokens";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
} from "../chatgpt-web-models";
import type { AppConfig } from "../config";
import { parseRequest } from "../responses/parser";
import { compactRequest, responseRequest, routeChatGptWebRequest } from "../server";
import { namespacedToolName, type AdapterEvent, type CodexProviderConfig } from "../types";
import {
  createDevContextFiller,
  type DevChatModel,
  type DevChatState,
  type DevChatStore,
  type DevChatUsage,
} from "./session";

export type AdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export type DevChatEvent =
  | { type: "reasoning"; text: string }
  | { type: "commentary"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; receipt: Record<string, unknown> }
  | { type: "compaction_start"; reason: "automatic" | "manual"; inputItems: number }
  | { type: "compaction_done"; reason: "automatic" | "manual"; inputItems: number };

export interface DevContextStatus {
  model: DevChatModel;
  inputTokens: number;
  autoCompactTokenLimit: number;
  contextWindow: number;
  browserInputTokenLimit?: number;
  percent: number;
  inputItems: number;
}

export interface DevChatTurnResult {
  text: string;
  usage: DevChatUsage;
  toolCalls: number;
  compactions: number;
  status: DevContextStatus;
}

export interface ResponsesEnvelope {
  id?: string;
  status?: string;
  output?: unknown[];
  end_turn?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string } | null;
  incomplete_details?: { reason?: string; message?: string } | null;
}

interface DevToolCall {
  kind: "function" | "custom";
  callId: string;
  name: string;
  input: unknown;
}

export const DEV_CHAT_SYSTEM_INSTRUCTIONS = [
  "You are running inside the Codex Web GPT DEV outer-harness simulator.",
  "Behave like the normal Codex model backend and use the available Codex Native tools whenever they help answer the user's request.",
  "Every outer tool result is an explicit simulation receipt. No command, file edit, image read, user prompt, or external side effect actually occurs.",
  "Never describe a simulated receipt as a real-world effect. Continue reasoning from the receipt exactly as test evidence for the transport flow.",
].join(" ");

export const DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS = [
  "You are running inside the Codex Web GPT DEV outer-harness simulator.",
  "Behave like the normal Codex model backend.",
  "This browser-only DEV profile exposes no outer tools. Do not claim that commands, file edits, UI actions, or external side effects occurred.",
].join(" ");

const ANY_ARGUMENTS = { type: "object", additionalProperties: true } as const;
const simulatedFunction = (name: string, description: string) => ({
  type: "function", name, parameters: ANY_ARGUMENTS,
  description: `DEV simulator: ${description}. Arguments are recorded and no side effect occurs.`,
});

export const DEV_CHAT_TOOLS: readonly Record<string, unknown>[] = [
  simulatedFunction("exec_command", "native command execution"),
  simulatedFunction("write_stdin", "native command-session continuation"),
  { type: "custom", name: "apply_patch", description: "DEV simulator: records patch text and changes no file." },
  simulatedFunction("view_image", "native image inspection"),
  simulatedFunction("request_user_input", "native user input"),
  {
    type: "namespace", name: "mcp__dev_simulator",
    description: "Synthetic deferred MCP tools for inventory and generic dispatch tests.",
    tools: [simulatedFunction("echo", "structured MCP echo")],
  },
];

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function environmentContext(cwd: string): string {
  const escaped = xml(cwd);
  return `<environment_context>
  <cwd>${escaped}</cwd>
  <filesystem><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
  <codex_dev_mode>All outer tool effects are explicitly simulated.</codex_dev_mode>
</environment_context>`;
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function turnMetadata(threadId: string, turnId: string, cwd: string): string {
  return JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "none",
    workspaces: { [cwd]: {} },
  });
}

export function currentTurnItems(cwd: string, turnId: string, message: string): unknown[] {
  const itemMetadata = { turn_id: turnId };
  return [
    {
      type: "message",
      id: id("msg_dev_environment"),
      role: "user",
      content: [{ type: "input_text", text: environmentContext(cwd) }],
      internal_chat_message_metadata_passthrough: itemMetadata,
    },
    {
      type: "message",
      id: id("msg_dev_user"),
      role: "user",
      content: [{ type: "input_text", text: message }],
      internal_chat_message_metadata_passthrough: itemMetadata,
    },
  ];
}

export function requestBody(
  state: DevChatState,
  cwd: string,
  turnId: string,
  input: unknown[],
  stream: boolean,
  localToolsEnabled: boolean,
): Record<string, unknown> {
  return {
    model: state.model,
    instructions: localToolsEnabled ? DEV_CHAT_SYSTEM_INSTRUCTIONS : DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS,
    input,
    tools: localToolsEnabled ? DEV_CHAT_TOOLS : [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { summary: "auto" },
    stream,
    store: false,
    prompt_cache_key: state.threadId,
    client_metadata: {
      "x-codex-turn-metadata": turnMetadata(state.threadId, turnId, cwd),
    },
    metadata: { codex_chatgpt_web_dev: true, chat_name: state.name },
  };
}

export function responseError(response: ResponsesEnvelope): string {
  if (response.error?.message) {
    const suffix = [response.error.type, response.error.code].filter(Boolean).join("/");
    return suffix ? `${response.error.message} (${suffix})` : response.error.message;
  }
  if (response.incomplete_details?.message) return response.incomplete_details.message;
  if (response.incomplete_details?.reason) return `Responses turn was incomplete: ${response.incomplete_details.reason}`;
  return `Responses turn ended with status ${String(response.status ?? "unknown")}`;
}

export function observeAdapterEvent(event: AdapterEvent, emit: (event: DevChatEvent) => void): void {
  if (event.type === "thinking_delta") emit({ type: "reasoning", text: event.thinking });
  else if (event.type === "text_delta") {
    emit({ type: event.phase === "commentary" ? "commentary" : "text", text: event.text });
  }
}

export function toolCalls(output: unknown[]): DevToolCall[] {
  const calls: DevToolCall[] = [];
  for (const value of output) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.call_id !== "string") continue;
    if (item.type === "function_call" && typeof item.name === "string") {
      let input: unknown = {};
      if (typeof item.arguments === "string" && item.arguments.trim()) {
        try { input = JSON.parse(item.arguments); }
        catch { input = item.arguments; }
      }
      calls.push({
        kind: "function",
        callId: item.call_id,
        name: namespacedToolName(typeof item.namespace === "string" ? item.namespace : undefined, item.name),
        input,
      });
    } else if (item.type === "custom_tool_call" && typeof item.name === "string") {
      calls.push({ kind: "custom", callId: item.call_id, name: item.name, input: item.input ?? "" });
    }
  }
  return calls;
}

export function simulatedReceipt(state: DevChatState, turnId: string, call: DevToolCall): Record<string, unknown> {
  return {
    type: "codex_dev_simulated_tool_result",
    simulated: true,
    side_effects_performed: false,
    chat: state.name,
    turn_id: turnId,
    call_id: call.callId,
    tool: { name: call.name, kind: call.kind },
    received_input: call.input,
    output: `Simulated ${call.name}; no command, file, UI, user, or external side effect was performed.`,
  };
}

export function toolOutput(call: DevToolCall, receipt: Record<string, unknown>): Record<string, unknown> {
  const metadata = { turn_id: receipt.turn_id };
  if (call.kind === "custom") {
    return {
      type: "custom_tool_call_output",
      call_id: call.callId,
      output: JSON.stringify(receipt),
      internal_chat_message_metadata_passthrough: metadata,
    };
  }
  return {
    type: "function_call_output",
    call_id: call.callId,
    output: JSON.stringify(receipt),
    internal_chat_message_metadata_passthrough: metadata,
  };
}

export function historyOutput(output: unknown[], turnId: string): unknown[] {
  return output.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    const metadata = item.internal_chat_message_metadata_passthrough;
    if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
      throw new Error("DEV Responses output carried invalid native item metadata");
    }
    const existing = (metadata as Record<string, unknown> | undefined)?.turn_id;
    if (existing !== undefined && existing !== turnId) {
      throw new Error(`DEV Responses output belongs to another turn: ${String(existing)}`);
    }
    return {
      ...item,
      internal_chat_message_metadata_passthrough: {
        ...(metadata as Record<string, unknown> | undefined),
        turn_id: turnId,
      },
    };
  });
}

export function outputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const value of output) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as { type?: unknown; phase?: unknown; content?: unknown };
    if (item.type !== "message" || !Array.isArray(item.content) || item.phase === "commentary") continue;
    for (const raw of item.content) {
      const block = raw as { type?: unknown; text?: unknown };
      if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("");
}

export function usageOf(response: ResponsesEnvelope): DevChatUsage {
  const inputTokens = Number.isInteger(response.usage?.input_tokens) ? response.usage!.input_tokens! : 0;
  const outputTokens = Number.isInteger(response.usage?.output_tokens) ? response.usage!.output_tokens! : 0;
  const totalTokens = Number.isInteger(response.usage?.total_tokens)
    ? response.usage!.total_tokens!
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

export function defaultDevChatModel(config: AppConfig): DevChatModel {
  if (config.browserInteractionMode === "manual") return "chatgpt-web/zero-risk";
  return config.solAvailable ? "chatgpt-web/light" : "chatgpt-web/luna";
}

export function prepareWorkingTreeBrowserHelper(): string | undefined {
  const root = resolve(import.meta.dir, "..", "..");
  const buildScript = join(root, "scripts", "build-browser-helper.ts");
  if (!existsSync(buildScript)) return undefined;
  const output = join(root, ".launcher-runtime", "browser-helper.cjs");
  const build = Bun.spawnSync([process.execPath, "run", buildScript, output], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`Could not build the working-tree browser helper: ${build.stderr.toString().trim() || build.stdout.toString().trim()}`);
  }
  return output;
}

export function createLauncherDevAdapter(
  config: AppConfig,
  runtimeStateRoot: string,
  options: { broker?: TurnBrokerOwner; browserHelperScriptPath?: string } = {},
): { broker: TurnBrokerOwner; adapterFactory: AdapterFactory } {
  const broker = options.broker ?? new RemoteTurnBroker(config.brokerSocketPath);
  const browserHelperScriptPath = options.browserHelperScriptPath ?? prepareWorkingTreeBrowserHelper();
  const adapterFactory: AdapterFactory = provider => createChatGptWebAdapter({
    ...provider,
    chatgptWeb: {
      ...provider.chatgptWeb,
      ...(browserHelperScriptPath ? { browserHelperScriptPath } : {}),
      browserDiagnosticsPath: join(runtimeStateRoot, "diagnostics", "browser-turns"),
      threadEnvironmentStatePath: join(runtimeStateRoot, "thread-environments.json"),
      lunaCheckpointStatePath: join(runtimeStateRoot, "luna-checkpoints.json"),
      turnTimeoutMs: 60 * 60_000,
      ...(config.experimentalBiggerContext ? { experimentalBiggerContext: true } : {}),
    },
  }, { broker });
  return { broker, adapterFactory };
}
