import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { cwd } from "node:process";
import { isClaudeCompactRequest } from "./compact";
import { resolveClaudeGatewayModelId } from "./models";

type Json = Record<string, unknown>;
type TextFilter = (text: string) => string | undefined;

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Json;
}

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(block => {
    const part = object(block, "content block");
    return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

function inputParts(content: unknown, filterText: TextFilter = text => text): Json[] {
  if (typeof content === "string") {
    const text = filterText(content);
    return text === undefined ? [] : [{ type: "input_text", text }];
  }
  if (!Array.isArray(content)) return [];
  const parts: Json[] = [];
  for (const raw of content) {
    const block = object(raw, "message content block");
    if (block.type === "text" && typeof block.text === "string") {
      const text = filterText(block.text);
      if (text !== undefined) parts.push({ type: "input_text", text });
    } else if (block.type === "image") {
      const source = object(block.source, "image source");
      if (source.type !== "base64" || typeof source.media_type !== "string" || typeof source.data !== "string") {
        throw new Error("only base64 Claude image sources are supported");
      }
      parts.push({ type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` });
    }
  }
  return parts;
}

function assistantItems(content: unknown): Json[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) return [];
  const items: Json[] = [];
  let text: Json[] = [];
  const flushText = () => {
    if (text.length > 0) items.push({ type: "message", role: "assistant", content: text });
    text = [];
  };
  for (const raw of blocks) {
    const block = object(raw, "assistant content block");
    if (block.type === "text" && typeof block.text === "string") {
      text.push({ type: "output_text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      flushText();
      items.push({ type: "reasoning", summary: [{ type: "summary_text", text: block.thinking }] });
    } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
      flushText();
      items.push({ type: "reasoning", encrypted_content: block.data });
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      flushText();
      items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  flushText();
  return items;
}

function userItems(content: unknown, turnId: string, filterText?: TextFilter): Json[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) return [];
  const filter = filterText ?? (text => text);
  const items: Json[] = [];
  const ordinary = inputParts(blocks, filter);
  if (ordinary.length > 0) {
    items.push({
      type: "message",
      role: "user",
      content: ordinary,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
  }
  for (const raw of blocks) {
    const block = object(raw, "user content block");
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const output = typeof block.content === "string" ? (filter(block.content) ?? "") : inputParts(block.content, filter);
    items.push({ type: "function_call_output", call_id: block.tool_use_id, output });
  }
  return items;
}

function safeId(value: string, fallback: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return safe || fallback;
}

export function claudeSessionThreadId(sessionId: string): string {
  return `claude_${safeId(sessionId, "ephemeral")}`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function workingDirectory(system: string): string {
  const match = system.match(/^\s*-?\s*(?:Primary )?working directory:\s*(.+?)\s*$/mi);
  const candidate = match?.[1]?.replace(/^`|`$/g, "").trim();
  return candidate && isAbsolute(candidate) ? candidate : cwd();
}

function environment(turnId: string, root: string): Json {
  const escaped = xml(root);
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `<environment_context><cwd>${escaped}</cwd><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>` }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function toolChoice(value: unknown): unknown {
  if (!value) return undefined;
  const choice = object(value, "tool_choice");
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") return { type: "function", name: choice.name };
  return undefined;
}

function claudeTitleResponse(request: Json, system: string): string | undefined {
  const outputConfig = request.output_config;
  if (!outputConfig || typeof outputConfig !== "object" || Array.isArray(outputConfig)) return undefined;
  const format = (outputConfig as Json).format;
  if (!format || typeof format !== "object" || Array.isArray(format) || (format as Json).type !== "json_schema") return undefined;
  const schema = (format as Json).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const properties = (schema as Json).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("title" in properties)) return undefined;
  if (!system.includes("Generate a concise, sentence-case title")
    || !system.includes("Return JSON with a single \"title\" field.")) return undefined;
  const latestUser = [...request.messages as unknown[]].reverse().find(raw => raw && typeof raw === "object"
    && !Array.isArray(raw) && (raw as Json).role === "user") as Json | undefined;
  const session = textBlocks(latestUser?.content).match(/<session>\s*([\s\S]*?)\s*<\/session>/i)?.[1];
  const firstLine = session?.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "Claude Code session";
  return JSON.stringify({ title: [...firstLine].slice(0, 80).join("") });
}

export interface TranslatedClaudeRequest {
  requestedModel: string;
  stream: boolean;
  compact: boolean;
  suppressedSteeringReplays: number;
  auxiliaryResponse?: string;
  body: Json;
}

type ClaudeSteeringSuppressionCount = (threadId: string, instruction: string) => number;

const CLAUDE_MID_TURN_HEADER = "The user sent a new message while you were working:";
const CLAUDE_MID_TURN_TAIL = "This is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.";

function claudeQueuedCommandInstruction(text: string): string | undefined {
  const trimmed = text.trim();
  const wrapper = trimmed.match(/^<system-reminder>\r?\n([\s\S]*)\r?\n<\/system-reminder>$/);
  if (trimmed.startsWith("<system-reminder>") && !wrapper) return undefined;
  const message = wrapper?.[1] ?? trimmed;
  const header = message.match(new RegExp(`^${CLAUDE_MID_TURN_HEADER}\\r?\\n`));
  if (!header) return undefined;
  const body = message.slice(header[0].length);
  const separators = [...body.matchAll(/\r?\n\r?\n/g)];
  for (const boundary of separators.reverse()) {
    const tail = body.slice(boundary.index! + boundary[0].length);
    if (tail === CLAUDE_MID_TURN_TAIL || /^IMPORTANT:[\s\S]*\bmessage above\b/i.test(tail)) {
      return body.slice(0, boundary.index);
    }
  }
  return undefined;
}

function filterClaudeQueuedCommandReplays(text: string, suppress: (instruction: string) => boolean): string | undefined {
  const whole = claudeQueuedCommandInstruction(text);
  if (whole !== undefined && suppress(whole)) return undefined;
  let cursor = 0;
  let filtered = "";
  let changed = false;
  for (const match of text.matchAll(/<system-reminder>\r?\n[\s\S]*?\r?\n<\/system-reminder>/g)) {
    const instruction = claudeQueuedCommandInstruction(match[0]);
    if (instruction === undefined || !suppress(instruction)) continue;
    filtered += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    changed = true;
  }
  filtered = changed ? filtered + text.slice(cursor) : text;
  const bareStart = filtered.lastIndexOf(`\n${CLAUDE_MID_TURN_HEADER}`);
  if (bareStart >= 0) {
    const instruction = claudeQueuedCommandInstruction(filtered.slice(bareStart + 1));
    if (instruction !== undefined && suppress(instruction)) {
      const cut = bareStart > 0 && filtered[bareStart - 1] === "\r" ? bareStart - 1 : bareStart;
      filtered = filtered.slice(0, cut);
    }
  }
  return filtered || undefined;
}

export function translateClaudeMessages(
  raw: unknown,
  headers: Headers,
  suppressionCount?: ClaudeSteeringSuppressionCount,
): TranslatedClaudeRequest {
  const request = object(raw, "request body");
  const discoveredModel = typeof request.model === "string"
    ? resolveClaudeGatewayModelId(request.model)
    : undefined;
  if (typeof request.model !== "string"
    || (!discoveredModel && !request.model.startsWith("chatgpt-web/") && !request.model.startsWith("chatgpt-web-"))) {
    throw new Error("model must be an existing chatgpt-web route slug or Claude Code alias");
  }
  const model = discoveredModel ?? (request.model.startsWith("chatgpt-web-")
    ? `chatgpt-web/${request.model.slice("chatgpt-web-".length)}`
    : request.model);
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw new Error("messages must be a non-empty array");
  if (request.max_tokens !== undefined && (!Number.isFinite(request.max_tokens) || Number(request.max_tokens) < 1)) {
    throw new Error("max_tokens must be a positive number");
  }

  const session = safeId(headers.get("x-claude-code-session-id") ?? randomUUID(), "ephemeral");
  const subagent = headers.has("x-claude-code-agent-id");
  const agent = safeId(headers.get("x-claude-code-agent-id") ?? "root", "root");
  const threadId = claudeSessionThreadId(session);
  const turnId = `claude_${agent}`;
  const system = textBlocks(request.system);
  const auxiliaryResponse = claudeTitleResponse(request, system);
  const root = workingDirectory(system);
  const input: Json[] = [];
  const suppressedByInstruction = new Map<string, number>();
  let suppressedSteeringReplays = 0;
  const consumeSuppression = (instruction: string): boolean => {
    if (!suppressionCount) return false;
    const used = suppressedByInstruction.get(instruction) ?? 0;
    if (used >= suppressionCount(threadId, instruction)) return false;
    suppressedByInstruction.set(instruction, used + 1);
    suppressedSteeringReplays += 1;
    return true;
  };
  const filterUserText = (text: string) => filterClaudeQueuedCommandReplays(text, consumeSuppression);
  let latestUserOffset = -1;
  for (const rawMessage of request.messages) {
    const message = object(rawMessage, "message");
    if (message.role === "assistant") input.push(...assistantItems(message.content));
    else if (message.role === "system") {
      const content = textBlocks(message.content);
      if (content) input.push({ type: "message", role: "system", content: [{ type: "input_text", text: content }] });
    } else if (message.role === "user") {
      const start = input.length;
      input.push(...userItems(message.content, turnId, filterUserText));
      if (input.slice(start).some(item => item.type === "message")) latestUserOffset = start;
    } else throw new Error("message role must be user or assistant");
  }
  if (latestUserOffset < 0) throw new Error("messages must contain a user text or image block");
  input.splice(latestUserOffset, 0, environment(turnId, root));

  const tools = Array.isArray(request.tools) ? request.tools.map(rawTool => {
    const tool = object(rawTool, "tool");
    if (typeof tool.name !== "string") throw new Error("tool name must be a string");
    return {
      type: "function",
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: object(tool.input_schema ?? {}, "tool input_schema"),
    };
  }) : undefined;
  const compact = isClaudeCompactRequest(system, request.messages);
  const choice = toolChoice(request.tool_choice);
  const harness = "You are serving Claude Code through ChatGPT Web. Follow the supplied system and user instructions. Use only advertised client tools; the client owns tool execution and permission decisions.";
  return {
    requestedModel: request.model,
    stream: request.stream === true,
    compact,
    suppressedSteeringReplays,
    ...(auxiliaryResponse ? { auxiliaryResponse } : {}),
    body: {
      model,
      stream: request.stream === true,
      input,
      instructions: [system, harness].filter(Boolean).join("\n\n"),
      ...(request.max_tokens !== undefined ? { max_output_tokens: request.max_tokens } : {}),
      ...(tools ? { tools } : {}),
      ...(choice !== undefined ? { tool_choice: choice } : {}),
      parallel_tool_calls: true,
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId, request_kind: "turn", sandbox: "none", workspaces: { [root]: {} } }),
        claude_request_hash: createHash("sha256").update(JSON.stringify(request.messages)).digest("hex"),
        claude_subagent: subagent,
        claude_retain_conversation: !auxiliaryResponse && headers.has("x-claude-code-session-id") && !subagent,
      },
    },
  };
}
