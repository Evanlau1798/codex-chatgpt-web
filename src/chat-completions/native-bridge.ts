import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { ChatCompletionError, decodeNativeChatCompletion, type ChatCompletionInput, type ChatCompletionResult,
  type ChatMessage, type ChatToolCall } from "./contract";

type ResponsesHandler = (req: Request, config: AppConfig) => Promise<Response>;
type Item = Record<string, unknown>;
interface PendingTurn {
  threadId: string;
  turnId: string;
  metadata: string;
  input: Item[];
  history: ChatMessage[];
  calls: ChatToolCall[];
  content: string | null;
  tools: string;
  model: string;
  busy: boolean;
  expiresAt: number;
  body?: Item;
}
interface NativeTurnLifecycle {
  isLive?: (body: Item, callIds: string[], config: AppConfig) => boolean;
  retire?: (body: Item, config: AppConfig) => Promise<void>;
}

const TOOL_RESULT_DEADLINE_MS = 85_000; // The existing MCP transport retires an unresolved invocation at 90s.
const MAX_PENDING_TURNS = 128;
const CLIENT_VIRTUAL_CWD = process.platform === "win32" ? "C:\\api-client" : "/api-client";
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const item = (turnId: string, role: "user", text: string): Item => ({ type: "message", id: id("msg_api"), role,
  content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } });
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const environment = () => {
  const cwd = xml(CLIENT_VIRTUAL_CWD);
  return `<environment_context><cwd>${cwd}</cwd><sandbox_mode>read-only</sandbox_mode>`
    + `<filesystem><workspace_roots><root>${cwd}</root></workspace_roots></filesystem></environment_context>`;
};
const outputText = (output: Item[]): string => output.flatMap(value => {
  if (value.type !== "message" || value.phase === "commentary" || !Array.isArray(value.content)) return [];
  return value.content.flatMap(part => part && typeof part === "object" && typeof part.text === "string"
    && (part.type === "output_text" || part.type === "text") ? [part.text] : []);
}).join("");
const callItems = (output: Item[]): ChatToolCall[] => output.flatMap(value => value.type === "function_call"
  ? [{ id: value.call_id as string, type: "function" as const,
    function: { name: value.name as string, arguments: value.arguments as string } }] : []);
const toolFingerprint = (input: ChatCompletionInput) => JSON.stringify([input.tools, input.toolChoice, input.parallel]);

/** Server-owned identity lets a general Chat Completions client continue a single native Web tool turn. */
export class NativeChatCompletionBridge {
  private readonly pending = new Map<string, PendingTurn>();
  constructor(private readonly respond: ResponsesHandler, private readonly now: () => number = Date.now,
    private readonly lifecycle: NativeTurnLifecycle = {}) {}

  isContinuation(input: ChatCompletionInput): boolean {
    return input.messages.at(-1)?.role === "tool";
  }

  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.retire(pending);
  }

  private retire(turn: PendingTurn): void {
    for (const call of turn.calls) {
      this.pending.delete(call.id);
    }
  }

  private async cancel(turn: PendingTurn, config: AppConfig): Promise<void> {
    this.retire(turn);
    if (turn.body) await this.lifecycle.retire?.(turn.body, config);
  }

  async execute(input: ChatCompletionInput, config: AppConfig, signal: AbortSignal,
    _onText: (delta: string) => void): Promise<{ answer: string; result: ChatCompletionResult }> {
    this.prune();
    signal.throwIfAborted();
    let turn: PendingTurn;
    const continuation = this.isContinuation(input);
    if (continuation) {
      const results: ChatMessage[] = [];
      for (let index = input.messages.length - 1; index >= 0 && input.messages[index]!.role === "tool"; index--) {
        results.unshift(input.messages[index]!);
      }
      const owner = results.map(result => this.pending.get(result.tool_call_id!)).find(Boolean);
      if (!owner || owner.busy || results.length !== owner.calls.length || input.model !== owner.model
        || toolFingerprint(input) !== owner.tools || input.messages.length !== owner.history.length + 1 + results.length
        || JSON.stringify(input.messages.slice(0, owner.history.length)) !== JSON.stringify(owner.history)) {
        throw new ChatCompletionError("Tool continuation is unavailable or conflicts with the pending Web turn", 409, "tool_continuation_conflict");
      }
      const assistant = input.messages[owner.history.length]!;
      const expectedContent = owner.content;
      if (assistant.role !== "assistant" || (expectedContent === null
        ? assistant.content !== null && assistant.content !== "" : assistant.content !== expectedContent)
        || JSON.stringify(assistant.tool_calls) !== JSON.stringify(owner.calls)
        || results.some(result => !owner.calls.some(call => call.id === result.tool_call_id)
          || this.pending.get(result.tool_call_id!) !== owner)) {
        throw new ChatCompletionError("Tool continuation does not match its pending Web turn", 409, "tool_continuation_conflict");
      }
      if (owner.body && this.lifecycle.isLive?.(owner.body, owner.calls.map(call => call.id), config) === false) {
        await this.cancel(owner, config);
        throw new ChatCompletionError("The pending Web tool turn has expired", 409, "tool_continuation_expired");
      }
      turn = owner;
      turn.busy = true;
      this.retire(turn);
      turn.input.push(...results.map(result => ({ type: "function_call_output", call_id: result.tool_call_id,
        output: result.content ?? "", internal_chat_message_metadata_passthrough: { turn_id: turn.turnId } })));
    } else {
      if (this.pending.size >= MAX_PENDING_TURNS) throw new ChatCompletionError("Too many pending Web tool turns", 429, "too_many_pending_turns");
      const threadId = id("api_thread"), turnId = id("api_turn");
      turn = { threadId, turnId, metadata: JSON.stringify({ thread_id: threadId, turn_id: turnId,
        request_kind: "turn", sandbox: "read-only", workspaces: { [CLIENT_VIRTUAL_CWD]: {} } }),
        input: [item(turnId, "user", environment()), item(turnId, "user",
          "Act as the backend for this external client conversation. The declared cwd is a virtual broker identity, "
          + "not the client's working directory. Preserve the supplied roles and message order. "
          + "Only the declared function tools are available; their calls are returned to the client for execution. "
          + "Do not claim that you executed a client tool before its result is supplied.\n\n"
          + JSON.stringify({ messages: input.messages }))],
        history: input.messages, calls: [], content: null, tools: toolFingerprint(input), model: input.model,
        busy: true, expiresAt: this.now() + TOOL_RESULT_DEADLINE_MS };
    }
    let dispatched = false;
    try {
      const body = { model: input.model, instructions: "You are the model backend for an external client. "
        + "Invoke only the declared client functions; their results return in this same turn. Reply with ordinary Markdown.",
        input: turn.input, tools: input.tools.map(tool => ({ type: "function", name: tool.function.name,
          description: tool.function.description ?? "Client-executed function", parameters: tool.function.parameters })),
        tool_choice: typeof input.toolChoice === "object" ? { type: "function", name: input.toolChoice.name } : input.toolChoice,
        parallel_tool_calls: input.parallel, stream: false, store: false,
        prompt_cache_key: turn.threadId, client_metadata: { "x-codex-turn-metadata": turn.metadata } };
      turn.body = body;
      dispatched = true;
      const response = await this.respond(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
      }), config);
      const envelope = await response.json() as { status?: unknown; end_turn?: unknown; output?: unknown; error?: { code?: string } };
      signal.throwIfAborted();
      if (!response.ok || envelope.status !== "completed" || !Array.isArray(envelope.output)) {
        const rateLimited = envelope.error?.code === "rate_limit_exceeded";
        const accountStop = envelope.error?.code === "chatgpt_account_safety_stop";
        throw new ChatCompletionError(rateLimited || accountStop ? "The Web service rejected this turn" : "The Web turn did not complete",
          accountStop ? 403 : rateLimited ? 429 : 502,
          accountStop ? "chatgpt_account_safety_stop" : rateLimited ? "rate_limit_exceeded" : "web_backend_error");
      }
      const output = envelope.output as Item[];
      const calls = callItems(output), content = outputText(output);
      if (calls.length > 0 && envelope.end_turn === true) {
        throw new ChatCompletionError("The Web turn returned tools after final completion", 502, "model_protocol_error");
      }
      if (calls.length === 0 && envelope.end_turn !== true) {
        throw new ChatCompletionError("The Web turn ended without a final answer", 502, "model_protocol_error");
      }
      const result = decodeNativeChatCompletion(input, calls.length ? (content || null) : content, calls);
      if (calls.length > 0 && !result.tool_calls?.length) {
        throw new ChatCompletionError("Tool calls exceeded the requested output budget", 502, "model_protocol_error");
      }
      if (result.tool_calls?.length) {
        if (this.pending.size + result.tool_calls.length > MAX_PENDING_TURNS) {
          throw new ChatCompletionError("Too many pending Web tool turns", 429, "too_many_pending_turns");
        }
        turn.input.push(...output.map(value => ({ ...value,
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId } })));
        turn.history = input.messages;
        turn.calls = result.tool_calls;
        turn.content = result.content;
        turn.expiresAt = this.now() + TOOL_RESULT_DEADLINE_MS;
        for (const call of turn.calls) this.pending.set(call.id, turn);
      }
      return { answer: result.content ?? "", result };
    } catch (error) {
      if (dispatched) {
        try { await this.cancel(turn, config); }
        catch { throw new ChatCompletionError("Failed Web turn could not be retired safely", 502, "tool_cleanup_failed"); }
      }
      throw error;
    } finally { turn.busy = false; }
  }
}
