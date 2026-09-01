import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
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
import { invokeChatGptMcpTool } from "./mcp-invocation";
import { withClaimedTurn, type ClaimedTurn } from "./mcp-turn-activity";
import {
  assertBrowserToolArguments,
  boundedConnectorToolArguments,
  browserToolDescription,
  browserToolParameters,
  CHATGPT_WEB_AGENT_WAIT_POLL_MS,
  matchingToolInventory,
} from "./mcp-tool-inventory";

export { CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, chatGptMcpInvocationTimeout } from "./mcp-invocation";
export { CHATGPT_WEB_AGENT_WAIT_POLL_MS, boundedConnectorToolArguments, matchingToolInventory } from "./mcp-tool-inventory";

const turnTokenSchema = z.string().min(20).max(256);
const contextTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
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

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "codex-native", version: VERSION });

  const withTurn = async <T>(
    toolName: string,
    turnToken: string,
    extra: Parameters<typeof requestScopeSummary>[0],
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> => {
    logToolPhase(toolName, "claim", "started", ` scope=${requestScopeSummary(extra)}`);
    try {
      return await withClaimedTurn(options.brokerSocketPath, turnToken, extra.signal, claimed => {
        logToolPhase(toolName, "claim", "completed", ` binding=${scopeHash(claimed.bindingId)}`);
        return action(claimed);
      });
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
    signal?: AbortSignal,
  ) => {
    const name = wireName(tool);
    const binding = scopeHash(bindingId);
    logToolPhase(name, "invoke", "started", ` binding=${binding}`);
    try {
      const response = await invokeChatGptMcpTool(options.brokerSocketPath, bindingId, bound, {
        wireName: name,
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
      }, signal);
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
    signal?: AbortSignal,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload),
    }, signal);
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
    signal?: AbortSignal,
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
      }, signal);
    }
    const claudeBash = exactTool(bound, "Bash");
    if (claudeBash && !claudeBash.freeform) {
      if (command.tty === true) throw new Error(ONE_SHOT_SHELL_TTY_ERROR);
      assertClaudeBashCommand(command.cmd);
      return invoke(claimed.bindingId, bound, claudeBash, {
        arguments: { command: claudeBashCommand(command.cmd, command.workdir) },
      }, signal);
    }
    const gateway = execGateway(bound);
    if (!gateway) throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
    return invoke(claimed.bindingId, bound, gateway, {
      input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
    }, signal);
  };

  server.registerTool(
    "codex_read_context",
    {
      title: "Read the current Codex task context",
      description: "Read the complete bridge-supplied Codex harness, history, handoff, and transport contract referenced by a short bootstrap prompt.",
      inputSchema: { context_token: contextTokenSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ context_token }, extra) => {
      const { context } = await callTurnBroker<{ context: string }>(
        options.brokerSocketPath,
        { method: "read_context", token: context_token },
        5_000,
        extra.signal,
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
      return withTurn("codex_exec", turn_token, extra, claimed => invokeNativeCommand(claimed, {
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { maxOutputTokens: max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
        }, extra.signal));
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
      return withTurn("codex_write_stdin", turn_token, extra, claimed => {
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
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, toolName, false, payload, extra.signal);
      });
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
      return withTurn("codex_apply_patch", turn_token, extra, claimed => {
        const bound = claimed.environment;
        const tool = exactTool(bound, "apply_patch");
        if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, extra.signal);
        return tool.freeform
          ? invoke(claimed.bindingId, bound, tool, { input: patch }, extra.signal)
          : invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra.signal);
      });
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
      return withTurn("codex_view_image", turn_token, extra, claimed => {
        const bound = claimed.environment;
        const tool = exactTool(bound, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra.signal);
      });
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
        return withTurn("codex_tool_inventory", turn_token, extra, claimed => {
          if (deferredSearch) {
            const searchQuery = deferredSearch[1]!.trim();
            if (!searchQuery) throw new Error("Codex deferred tool search query is empty");
            const searchTool = exactTool(claimed.environment, "tool_search");
            if (!searchTool?.toolSearch) throw new Error("This Codex turn did not advertise deferred tool search");
            return invoke(claimed.bindingId, claimed.environment, searchTool, {
              arguments: { query: searchQuery },
            }, extra.signal);
          }
          return invokeNativeCommand(claimed, {
            cmd: readTextFileCommand(readFile![1]!),
            yieldTimeMs: 30_000,
            maxOutputTokens: 1_000_000,
          }, extra.signal);
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
        }, 5_000, extra.signal);
        return { content: [{
          type: "text" as const,
          text: formatContextArchiveChunk(archive),
        }] };
      }
      return withTurn("codex_tool_inventory", turn_token, extra, claimed => {
        const matches = matchingToolInventory(claimed.environment.tools, query);
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
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return withTurn("codex_tool_call", turn_token, extra, claimed => {
        const bound = claimed.environment;
        const tool = namedTool(bound, wire_name);
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          return invoke(claimed.bindingId, bound, tool, { input }, extra.signal);
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const toolArguments = boundedConnectorToolArguments(tool, args ?? {});
        assertBrowserToolArguments(tool, toolArguments);
        if (tool.name === "Bash" && typeof toolArguments.command === "string") {
          assertClaudeBashCommand(toolArguments.command);
        }
        return invoke(claimed.bindingId, bound, tool, { arguments: toolArguments }, extra.signal);
      });
    },
  );

  await server.connect(new StdioServerTransport());
}
