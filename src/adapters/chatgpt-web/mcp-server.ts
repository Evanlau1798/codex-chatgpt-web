import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS } from "./context-bootstrap";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

const turnTokenSchema = z.string().min(20).max(256);
const contextTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});

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

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

const ONE_SHOT_SHELL_TTY_ERROR = "The one-shot shell_command cannot provide a TTY or accept later stdin. Pipe input inside the same command and use APIs compatible with the active platform shell.";
const CONNECTOR_LONG_POLL_SLICE_MS = 30_000;

export function boundedConnectorToolArguments(tool: CodexTool, args: Record<string, unknown>): Record<string, unknown> {
  if (!["wait", "multi_agent_v1__wait_agent", "collaboration__wait_agent"].includes(wireName(tool))) return args;
  const timeoutKey = typeof args.timeout_ms === "number" ? "timeout_ms"
    : typeof args.yield_time_ms === "number" ? "yield_time_ms" : undefined;
  if (!timeoutKey || (args[timeoutKey] as number) <= CONNECTOR_LONG_POLL_SLICE_MS) return args;
  return { ...args, [timeoutKey]: CONNECTOR_LONG_POLL_SLICE_MS };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
  ]);
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => nativeCommandNames.has(name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `if (nativeCommandName === ${JSON.stringify(shellCommandName)} && ${execCommandArguments.tty === true}) throw new Error(${JSON.stringify(ONE_SHOT_SHELL_TTY_ERROR)});`,
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}

function claudeBashCommand(cmd: string, workdir?: string): string {
  if (!workdir) return cmd;
  const quoted = /^[A-Za-z0-9_./:@%+=,-]+$/.test(workdir)
    ? workdir
    : `'${workdir.replaceAll("'", `'"'"'`)}'`;
  return `cd -- ${quoted} && ${cmd}`;
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
      const bound = claimed.environment;
      const execCommandArguments = {
        cmd,
        ...(workdir ? { workdir } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        ...(tty !== undefined ? { tty } : {}),
      };
      const shellCommandArguments = {
        command: cmd,
        ...(workdir ? { workdir } : {}),
        ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
      };
      const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
      if (tool) {
        if (tool.name === "shell_command" && tty === true) {
          throw new Error(ONE_SHOT_SHELL_TTY_ERROR);
        }
        const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
        return invoke(claimed.bindingId, bound, tool, { arguments: args });
      }
      const claudeBash = exactTool(bound, "Bash");
      if (claudeBash && !claudeBash.freeform) {
        if (tty === true) throw new Error(ONE_SHOT_SHELL_TTY_ERROR);
        return invoke(claimed.bindingId, bound, claudeBash, {
          arguments: { command: claudeBashCommand(cmd, workdir) },
        });
      }
      const gateway = execGateway(bound);
      if (!gateway) {
        throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
      }
      return invoke(claimed.bindingId, bound, gateway, {
        input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
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
        const nextQuery = archive.nextIndex === null ? "null" : `__codex_context__:${archive.nextIndex}`;
        return { content: [{
          type: "text" as const,
          text: [
            `CODEX_CONTEXT_ARCHIVE v=1 index=${archive.index} total=${archive.total} chars=${archive.context.length} sha256=${archive.sha256}`,
            archive.context,
            `CODEX_CONTEXT_ARCHIVE_END index=${archive.index} sha256=${archive.sha256} next_query=${nextQuery}`,
          ].join("\n"),
        }] };
      }
      const claimed = await claimTurn("codex_tool_inventory", turn_token, extra);
      const bound = claimed.environment;
      const matches = matchingToolInventory(bound.tools, query);
      const page = matches.slice(offset, offset + limit).map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: tool.description,
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: tool.parameters } : {}),
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
      const claimed = await claimTurn("codex_tool_call", turn_token, extra);
      const bound = claimed.environment;
      const tool = namedTool(bound, wire_name);
      if (tool.freeform) {
        if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
        return invoke(claimed.bindingId, bound, tool, { input });
      }
      if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
      return invoke(claimed.bindingId, bound, tool, { arguments: boundedConnectorToolArguments(tool, args ?? {}) });
    },
  );

  await server.connect(new StdioServerTransport());
}
