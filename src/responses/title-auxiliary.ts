import { bridgeToResponsesSSE } from "../bridge";
import type { AdapterEvent } from "../types";

/**
 * Codex's hidden TUI title turn is not a user turn.  It is an ephemeral,
 * structured request whose output is persisted by Codex only after this
 * response completes.  Keep this path deliberately independent from the Web
 * adapter so a missing canonical rollout can never turn a title request into
 * a browser turn.
 */
export const CODEX_TITLE_AUXILIARY_HANDLING = "codex-thread-title";
export const CODEX_TITLE_AUXILIARY_HEADER = "X-Codex-Local-Handling";

const TITLE_MAX_CHARS = 36;
const TITLE_PROMPT_MAX_BYTES = 960;
const CAPTION_SCAN_MAX_CHARS = 256;
const AUTO_TITLE_PREFIX =
  `Generate a concise, single-line task title of at most ${TITLE_MAX_CHARS} characters and under five words where possible. `
  + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\n";
const CONVERSATION_TITLE_PREFIX =
  `Generate a concise, single-line task title of at most ${TITLE_MAX_CHARS} characters and under five words where possible. `
  + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n"
  + "Prioritize the current task and latest substantive user request.\n\nRecent conversation messages:\n";

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : undefined;
}

function exactKeys(value: Json, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** The schema emitted by tui/src/app/thread_title.rs in Codex 0.155 and 0.159. */
export function isCodexThreadTitleSchema(value: unknown): boolean {
  const schema = record(value);
  if (!schema || !exactKeys(schema, ["additionalProperties", "properties", "required", "type"])) return false;
  if (schema.type !== "object" || schema.additionalProperties !== false) return false;
  if (!Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "title") return false;

  const properties = record(schema.properties);
  if (!properties || !exactKeys(properties, ["title"])) return false;
  const title = record(properties.title);
  return !!title
    && exactKeys(title, ["maxLength", "minLength", "type"])
    && title.type === "string"
    && title.minLength === 1
    && title.maxLength === TITLE_MAX_CHARS;
}

function titleOutputFormat(body: Json): boolean {
  const text = record(body.text);
  const format = record(text?.format);
  if (!format || format.type !== "json_schema" || !isCodexThreadTitleSchema(format.schema)) return false;
  return typeof format.name === "string" && format.name.length > 0 && format.strict === true;
}

function turnMetadata(body: Json): Json | undefined {
  const clientMetadata = record(body.client_metadata);
  const encoded = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof encoded === "string") {
    try { return record(JSON.parse(encoded)); } catch { return undefined; }
  }
  return record(encoded);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The native title turn carries the same framework envelope as a normal turn:
 * a developer message, an environment-context user message, and one generated
 * title prompt.  Requiring that sequence prevents a title-looking item inside
 * an ordinary task from bypassing normal admission checks.
 */
function titlePrompt(body: Json): string | undefined {
  if (!Array.isArray(body.input) || body.input.length !== 3) return undefined;

  const messageText = (value: unknown, role: "developer" | "user", singlePart: boolean): string | undefined => {
    const item = record(value);
    if (!item || item.type !== "message" || item.role !== role || !nonEmptyString(item.id)) return undefined;
    if (!Array.isArray(item.content) || item.content.length === 0 || (singlePart && item.content.length !== 1)) {
      return undefined;
    }
    const parts: string[] = [];
    for (const value of item.content) {
      const part = record(value);
      if (!part || part.type !== "input_text" || typeof part.text !== "string") return undefined;
      parts.push(part.text);
    }
    const text = parts.join("\n");
    return text.trim().length > 0 ? text : undefined;
  };

  const developer = messageText(body.input[0], "developer", false);
  const environment = messageText(body.input[1], "user", true);
  const prompt = messageText(body.input[2], "user", true);
  if (!developer || !environment || !prompt) return undefined;
  if (!/<environment_context>[\s\S]*<\/environment_context>/.test(environment.trim())) return undefined;
  return prompt;
}

function titleScaffoldTools(value: unknown): boolean {
  // Native Codex omits client-side tool_search when no MCP tools are loaded. The
  // remaining request_user_input_async + clock pair is still a title-only
  // scaffold; every other tool shape must remain on the normal path.
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return false;

  let requestUserInput = false;
  let clock = false;
  let toolSearch = false;
  for (const raw of value) {
    const tool = record(raw);
    if (!tool || typeof tool.type !== "string") return false;
    if (tool.type === "function" && tool.name === "request_user_input_async") {
      if (requestUserInput) return false;
      requestUserInput = true;
      continue;
    }
    if (tool.type === "namespace" && tool.name === "clock") {
      if (clock || !Array.isArray(tool.tools) || tool.tools.length !== 2) return false;
      const names = new Set<string>();
      for (const rawClockTool of tool.tools) {
        const clockTool = record(rawClockTool);
        if (!clockTool || clockTool.type !== "function" || typeof clockTool.name !== "string") return false;
        names.add(clockTool.name);
      }
      if (names.size !== 2 || !names.has("curr_time") || !names.has("sleep")) return false;
      clock = true;
      continue;
    }
    if (tool.type === "tool_search" && tool.execution === "client") {
      if (toolSearch) return false;
      toolSearch = true;
      continue;
    }
    // A title turn may carry only framework scaffolding. Any work-capable or
    // unknown tool must continue through ordinary admission and adapter paths.
    return false;
  }
  return requestUserInput && clock && (value.length === 2 || toolSearch);
}

function xmlDecode(value: string): string {
  // The TUI escapes only these three XML characters before creating the
  // conversation prompt. Decode in this order so an escaped ampersand cannot
  // become markup while we select the caption.
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function captionLine(value: string): string | undefined {
  const bounded = [...stripTerminalControls(value)].slice(0, CAPTION_SCAN_MAX_CHARS).join("");
  const line = bounded.split(/\r?\n/).map(part => part.trim()).find(Boolean);
  if (!line) return undefined;
  const normalized = line.replace(/\s+/g, " ").trim();
  const caption = [...normalized].slice(0, TITLE_MAX_CHARS).join("").trim();
  return caption || undefined;
}

function captionFromPrompt(prompt: string): string | undefined {
  if (prompt.length > TITLE_PROMPT_MAX_BYTES) return undefined;
  if (new TextEncoder().encode(prompt).byteLength > TITLE_PROMPT_MAX_BYTES) return undefined;
  if (prompt.startsWith(AUTO_TITLE_PREFIX)) {
    return captionLine(prompt.slice(AUTO_TITLE_PREFIX.length));
  }
  if (!prompt.startsWith(CONVERSATION_TITLE_PREFIX)) return undefined;

  const conversation = prompt.slice(CONVERSATION_TITLE_PREFIX.length);
  if (!conversation.startsWith("<conversation>\n") || !conversation.endsWith("\n</conversation>")) return undefined;
  const inner = conversation.slice("<conversation>\n".length, -"\n</conversation>".length);
  const messages = [...inner.matchAll(/<message role="(user|assistant)">([\s\S]*?)<\/message>/g)];
  if (messages.length === 0 || messages.map(message => message[0]).join("\n") !== inner) return undefined;
  const latest = messages.filter(message => message[1] === "user").at(-1)?.[2];
  return latest === undefined ? undefined : captionLine(xmlDecode(latest));
}

function localTitleBody(model: string, title: string): Record<string, unknown> {
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const itemId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const output = [{
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text: JSON.stringify({ title }), annotations: [] }],
  }];
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model,
    output,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function localHeaders(stream: boolean): Headers {
  const headers = new Headers({
    [CODEX_TITLE_AUXILIARY_HEADER]: CODEX_TITLE_AUXILIARY_HANDLING,
    "X-Codex-Response-Provenance": "local-auxiliary",
    "X-Reasoning-Included": "true",
  });
  if (stream) {
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");
    headers.set("X-Accel-Buffering", "no");
  } else {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

async function* localTitleEvents(title: string): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: JSON.stringify({ title }), phase: "final_answer" };
  yield {
    type: "done",
    stopReason: "stop",
    endTurn: true,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

/**
 * Return a complete local Responses envelope only for a recognized Codex title
 * auxiliary request.  `undefined` means the caller must continue through the
 * normal parser/admission/adapter path.
 */
export function codexTitleAuxiliaryResponse(body: unknown): Response | undefined {
  const request = record(body);
  if (!request || typeof request.model !== "string" || !titleOutputFormat(request)) return undefined;
  if (!nonEmptyString(request.instructions)
    || (request.previous_response_id !== undefined && request.previous_response_id !== null)) return undefined;
  if (request.tool_choice !== "auto" || !titleScaffoldTools(request.tools)) return undefined;
  if (typeof request.stream !== "boolean") return undefined;

  const metadata = turnMetadata(request);
  const source = metadata?.thread_source;
  if (source !== "thread_title" && source !== "system") return undefined;
  if (metadata?.request_kind !== "turn" || !nonEmptyString(metadata.thread_id) || !nonEmptyString(metadata.turn_id)) {
    return undefined;
  }

  const prompt = titlePrompt(request);
  const title = prompt === undefined ? undefined : captionFromPrompt(prompt);
  if (!title) return undefined;

  const model = request.model;
  if (request.stream === true) {
    const stream = bridgeToResponsesSSE(
      localTitleEvents(title),
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      2_000,
    );
    return new Response(stream, { headers: localHeaders(true) });
  }

  return new Response(JSON.stringify(localTitleBody(model, title)), { headers: localHeaders(false) });
}
