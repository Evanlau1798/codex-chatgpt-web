import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS } from "./context-bootstrap";
import { formatContextArchiveChunk } from "./context-archive-response";
import {
  assertClaudeBashCommand,
  claudeBashCommand,
  execCommandGatewayProgram,
  execGatewayProgram,
  ONE_SHOT_SHELL_TTY_ERROR,
  readTextFileCommand,
} from "./native-command";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

const turnTokenSchema = z.string().min(20).max(256);
const contextTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 10_000;

export function matchingToolInventory(tools: CodexTool[], query?: string): CodexTool[] {
  const terms = query?.trim().toLowerCase().split(/[\s,]+/).filter(Boolean) ?? [];
  return tools.map((tool, index) => {
    const name = wireName(tool).toLowerCase();
    const haystack = [name, tool.name, tool.namespace ?? "", tool.description].join("\n").toLowerCase();
    return {
      tool,
      index,
      exact: terms.some(term => term === name || term === tool.name.toLowerCase()),
      matches: terms.length === 0 || terms.some(term => haystack.includes(term)),
    };
  }).filter(({ matches }) => matches)
    .sort((left, right) => Number(right.exact) - Number(left.exact) || left.index - right.index)
    .map(({ tool }) => tool);
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
}): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function diagnosticErrorType(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}

function logToolPhase(
  toolName: string,
  phase: "claim" | "invoke",
  status: "started" | "completed" | "failed",
  detail = "",
): void {
  console.error(`[chatgpt-web-mcp] tool=${toolName} phase=${phase} status=${status}${detail}`);
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function namedTool(environment: ChatGptTurnEnvironment, requestedWireName: string): CodexTool {
  const tool = environment.tools.find(candidate => wireName(candidate) === requestedWireName);
  if (!tool) throw new Error(`Codex tool is not available in this turn: ${requestedWireName}`);
  return tool;
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return tool.name === "wait_agent"
    && (tool.namespace === "multi_agent_v1" || tool.namespace === "multi_agent_v2");
}

function browserToolDescription(tool: CodexTool): string {
  if (!isAgentWaitTool(tool)) return tool.description;
  return `${tool.description}\n\nChatGPT Web transport rule: wait for exactly 10 seconds per call, then release the MCP channel so spawned Web agents can use their own tools. Repeat with the same target ids until a terminal status is returned.`;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: "Required transport-safe polling interval. Use exactly 10000 and repeat the same targets until completion.",
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt?: number }): number | null {
  return environment.expiresAt === undefined ? null : Math.max(1, environment.expiresAt - Date.now());
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

const CONNECTOR_LONG_POLL_SLICE_MS = 30_000;

export function boundedConnectorToolArguments(tool: CodexTool, args: Record<string, unknown>): Record<string, unknown> {
  if (!["wait", "multi_agent_v1__wait_agent", "collaboration__wait_agent"].includes(wireName(tool))) return args;
  const timeoutKey = typeof args.timeout_ms === "number" ? "timeout_ms"
    : typeof args.yield_time_ms === "number" ? "yield_time_ms" : undefined;
  if (!timeoutKey || (args[timeoutKey] as number) <= CONNECTOR_LONG_POLL_SLICE_MS) return args;
  return { ...args, [timeoutKey]: CONNECTOR_LONG_POLL_SLICE_MS };
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "codex-native", version: "4.1.0" });

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: Parameters<typeof requestScopeSummary>[0],
  ): Promise<ClaimedTurn> => {
    logToolPhase(toolName, "claim", "started", ` scope=${requestScopeSummary(extra)}`);
    try {
      const claimed = await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, { method: "claim", token: turnToken });
      logToolPhase(toolName, "claim", "completed", ` binding=${scopeHash(claimed.bindingId)}`);
      return claimed;
    } catch (error) {
      logToolPhase(toolName, "claim", "failed", ` errorType=${diagnosticErrorType(error)}`);
      throw error;
    }
  };

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const name = wireName(tool);
    const binding = scopeHash(bindingId);
    logToolPhase(name, "invoke", "started", ` binding=${binding}`);
    try {
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId,
        wireName: name,
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
      }, invocationTimeout(bound));
      logToolPhase(name, "invoke", "completed", ` isError=${response.isError === true} binding=${binding}`);
      return asMcpResult(response);
    } catch (error) {
      logToolPhase(name, "invoke", "failed", ` errorType=${diagnosticErrorType(error)} binding=${binding}`);
      throw error;
    }
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload),
    });
  };

  const invokeNativeCommand = (
    claimed: ClaimedTurn,
    command: {
      cmd: string;
      workdir?: string;
      yieldTimeMs?: number;
      maxOutputTokens?: number;
      tty?: boolean;
    },
  ) => {
    const bound = claimed.environment;
    const execCommandArguments = {
      cmd: command.cmd,
      ...(command.workdir ? { workdir: command.workdir } : {}),
      ...(command.yieldTimeMs !== undefined ? { yield_time_ms: command.yieldTimeMs } : {}),
      ...(command.maxOutputTokens !== undefined ? { max_output_tokens: command.maxOutputTokens } : {}),
      ...(command.tty !== undefined ? { tty: command.tty } : {}),
    };
    const shellCommandArguments = {
      command: command.cmd,
      ...(command.workdir ? { workdir: command.workdir } : {}),
      ...(command.yieldTimeMs !== undefined ? { timeout_ms: command.yieldTimeMs } : {}),
    };
    const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
    if (tool) {
      if (tool.name === "shell_command" && command.tty === true) throw new Error(ONE_SHOT_SHELL_TTY_ERROR);
      return invoke(claimed.bindingId, bound, tool, {
        arguments: tool.name === "exec_command" ? execCommandArguments : shellCommandArguments,
      });
    }
    const claudeBash = exactTool(bound, "Bash");
    if (claudeBash && !claudeBash.freeform) {
      if (command.tty === true) throw new Error(ONE_SHOT_SHELL_TTY_ERROR);
      assertClaudeBashCommand(command.cmd);
      return invoke(claimed.bindingId, bound, claudeBash, {
        arguments: { command: claudeBashCommand(command.cmd, command.workdir) },
      });
    }
    const gateway = execGateway(bound);
    if (!gateway) throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
    return invoke(claimed.bindingId, bound, gateway, {
      input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
    });
  };

  server.registerTool(
    "codex_read_context",
    {
      title: "Read the current Codex task context",
      description: "Read the complete bridge-supplied Codex harness, history, handoff, and transport contract referenced by a short bootstrap prompt.",
      inputSchema: { context_token: contextTokenSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ context_token }) => {
      const { context } = await callTurnBroker<{ context: string }>(
        options.brokerSocketPath,
        { method: "read_context", token: context_token },
      );
      return { content: [{ type: "text" as const, text: context }] };
    },
  );

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.",
      inputSchema: {
        turn_token: turnTokenSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, cmd, workdir, yield_time_ms, max_output_tokens, tty }, extra) => {
      const claimed = await claimTurn("codex_exec", turn_token, extra);
      return invokeNativeCommand(claimed, {
        cmd,
        ...(workdir ? { workdir } : {}),
        ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { maxOutputTokens: max_output_tokens } : {}),
        ...(tty !== undefined ? { tty } : {}),
      });
    },
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: "Write characters to, or poll, a numeric session_id or string cell_id returned by codex_exec.",
      inputSchema: {
        turn_token: turnTokenSchema,
        session_id: z.union([z.number().int().nonnegative(), z.string().min(1).max(512)]),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, session_id, chars, yield_time_ms, max_output_tokens }, extra) => {
      const claimed = await claimTurn("codex_write_stdin", turn_token, extra);
      const bound = claimed.environment;
      const cellId = typeof session_id === "string" ? session_id : undefined;
      const toolName = cellId !== undefined && chars === undefined ? "wait" : "write_stdin";
      const tool = exactTool(bound, toolName);
      const payload = { arguments: {
        ...(toolName === "wait" ? { cell_id: cellId } : { session_id }),
        ...(chars !== undefined ? { chars } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { [toolName === "wait" ? "max_tokens" : "max_output_tokens"]: max_output_tokens } : {}),
      } };
      return tool
        ? invoke(claimed.bindingId, bound, tool, payload)
        : invokeNestedNative(claimed.bindingId, bound, toolName, false, payload);
    },
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task.",
      inputSchema: { turn_token: turnTokenSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ turn_token, patch }, extra) => {
      const claimed = await claimTurn("codex_apply_patch", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "apply_patch");
      if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch });
      return tool.freeform
        ? invoke(claimed.bindingId, bound, tool, { input: patch })
        : invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } });
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response.",
      inputSchema: {
        turn_token: turnTokenSchema,
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, path, detail }, extra) => {
      const claimed = await claimTurn("codex_view_image", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "view_image");
      const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
      return tool
        ? invoke(claimed.bindingId, bound, tool, payload)
        : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload);
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        turn_token: turnTokenSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, query, offset, limit, include_schema }, extra) => {
      const deferredSearch = /^__codex_tool_search__:([\s\S]+)$/.exec(query ?? "");
      const readFile = /^__codex_read_file__:([\s\S]+)$/.exec(query ?? "");
      if (deferredSearch || readFile) {
        const claimed = await claimTurn("codex_tool_inventory", turn_token, extra);
        if (deferredSearch) {
          const searchQuery = deferredSearch[1]!.trim();
          if (!searchQuery) throw new Error("Codex deferred tool search query is empty");
          const searchTool = exactTool(claimed.environment, "tool_search");
          if (!searchTool?.toolSearch) throw new Error("This Codex turn did not advertise deferred tool search");
          return invoke(claimed.bindingId, claimed.environment, searchTool, {
            arguments: { query: searchQuery },
          });
        }
        return invokeNativeCommand(claimed, {
          cmd: readTextFileCommand(readFile![1]!),
          yieldTimeMs: 30_000,
          maxOutputTokens: 1_000_000,
        });
      }
      const archiveMatch = /^__codex_context__:(\d+)$/.exec(query?.trim() ?? "");
      if (archiveMatch) {
        const requestedIndex = Number(archiveMatch[1]);
        const archive = await callTurnBroker<{
          context: string;
          index: number;
          total: number;
          sha256: string;
          nextIndex: number | null;
        }>(options.brokerSocketPath, {
          method: "read_context",
          token: turn_token,
          index: requestedIndex,
          chunkChars: CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS,
        });
        return { content: [{
          type: "text" as const,
          text: formatContextArchiveChunk(archive),
        }] };
      }
      const claimed = await claimTurn("codex_tool_inventory", turn_token, extra);
      const bound = claimed.environment;
      const matches = matchingToolInventory(bound.tools, query);
      const page = matches.slice(offset, offset + limit).map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: browserToolDescription(tool),
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
      }));
      return result({
        tools: page,
        total: matches.length,
        next_offset: offset + page.length < matches.length ? offset + page.length : null,
      });
    },
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
      inputSchema: {
        turn_token: turnTokenSchema,
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, wire_name, arguments: args, input }, extra) => {
      if (wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (input !== undefined) throw new Error("Compaction control handoff does not accept freeform input");
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Compaction control handoff requires handoff_id");
        }
        if (typeof summary !== "string") throw new Error("Compaction control handoff requires summary");
        await callTurnBroker(options.brokerSocketPath, {
          method: "submit_compaction_handoff",
          token: turn_token,
          handoffId,
          summary,
        });
        return result({ submitted: true });
      }
      const claimed = await claimTurn("codex_tool_call", turn_token, extra);
      const bound = claimed.environment;
      const tool = namedTool(bound, wire_name);
      if (tool.freeform) {
        if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
        return invoke(claimed.bindingId, bound, tool, { input });
      }
      if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
      const toolArguments = boundedConnectorToolArguments(tool, args ?? {});
      assertBrowserToolArguments(tool, toolArguments);
      if (tool.name === "Bash" && typeof toolArguments.command === "string") {
        assertClaudeBashCommand(toolArguments.command);
      }
      return invoke(claimed.bindingId, bound, tool, { arguments: toolArguments });
    },
  );

  await server.connect(new StdioServerTransport());
}
