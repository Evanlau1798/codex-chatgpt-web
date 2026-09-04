import { closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";
import { resolve } from "node:path";
import { estimateChatGptWebInputTokens } from "../adapters/chatgpt-web/usage";
import { CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET } from "../adapters/chatgpt-web/input-tokens";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
} from "../chatgpt-web-models";
import type { AppConfig } from "../config";
import { parseRequest } from "../responses/parser";
import { compactRequest, responseRequest, routeChatGptWebRequest } from "../server";
import {
  createDevContextFiller,
  type DevChatModel,
  type DevChatState,
  type DevChatStore,
  type DevChatUsage,
} from "./session";
import {
  currentTurnItems,
  defaultDevChatModel,
  DEV_CHAT_SYSTEM_INSTRUCTIONS,
  historyOutput,
  id,
  observeAdapterEvent,
  outputText,
  requestBody,
  responseError,
  simulatedReceipt,
  toolCalls,
  toolOutput,
  turnMetadata,
  usageOf,
  type AdapterFactory,
  type DevChatEvent,
  type DevChatTurnResult,
  type DevContextStatus,
  type ResponsesEnvelope,
} from "./driver-protocol";
export {
  createLauncherDevAdapter,
  defaultDevChatModel,
  DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS,
  DEV_CHAT_SYSTEM_INSTRUCTIONS,
  DEV_CHAT_TOOLS,
  prepareWorkingTreeBrowserHelper,
} from "./driver-protocol";
export type { DevChatEvent, DevChatTurnResult, DevContextStatus } from "./driver-protocol";

export interface DevChatFeatures {
  biggerContext: boolean;
}

const DEFAULT_DEV_CHAT_FEATURES: DevChatFeatures = { biggerContext: false };

const isLunaDevChatModel = (model: DevChatModel): boolean => (
  model === "chatgpt-web/luna" || model === "chatgpt-web/think"
);

export class DevChatDriver {
  constructor(
    readonly config: AppConfig,
    readonly store: DevChatStore,
    readonly adapterFactory: AdapterFactory,
    readonly cwd = process.cwd(),
    readonly features: DevChatFeatures = DEFAULT_DEV_CHAT_FEATURES,
  ) {}

  open(name: string, requestedModel?: DevChatModel): { state: DevChatState; created: boolean } {
    const model = requestedModel ?? defaultDevChatModel(this.config);
    requireChatGptWebModelRoute(model, this.config);
    this.assertBiggerContextModel(model);
    const opened = this.store.loadOrCreate(name, model, this.cwd);
    const modelChanged = requestedModel !== undefined && opened.state.model !== requestedModel;
    if (modelChanged) opened.state.model = requestedModel;
    if (resolve(opened.state.cwd) !== resolve(this.cwd)) {
      throw new Error(`DEV chat ${JSON.stringify(name)} belongs to ${opened.state.cwd}; use another name for ${this.cwd}`);
    }
    requireChatGptWebModelRoute(opened.state.model, this.config);
    this.assertBiggerContextModel(opened.state.model);
    if (opened.created || modelChanged) this.store.save(opened.state);
    return opened;
  }

  setModel(state: DevChatState, model: DevChatModel): void {
    requireChatGptWebModelRoute(model, this.config);
    this.assertBiggerContextModel(model);
    state.model = model;
    this.store.save(state);
  }

  reset(state: DevChatState): void {
    this.store.reset(state);
  }

  fill(state: DevChatState, targetTokens: number): { addedTokens: number; status: DevContextStatus } {
    const filler = createDevContextFiller(targetTokens);
    const fillerTurnId = id("dev_fill_turn");
    state.input.push({
      type: "message",
      id: id("msg_dev_fill"),
      role: "user",
      content: [{ type: "input_text", text: filler.text }],
      internal_chat_message_metadata_passthrough: { turn_id: fillerTurnId },
    });
    state.syntheticFills += 1;
    this.store.save(state);
    return { addedTokens: filler.tokens, status: this.status(state) };
  }

  status(state: DevChatState): DevContextStatus {
    const probeTurnId = id("dev_status_turn");
    const input = [...state.input, ...currentTurnItems(this.cwd, probeTurnId, "(DEV context status probe)")];
    return { ...this.statusForInput(state, probeTurnId, input), inputItems: state.input.length };
  }

  async compact(
    state: DevChatState,
    emit: (event: DevChatEvent) => void = () => {},
  ): Promise<DevContextStatus> {
    if (state.input.length === 0) throw new Error("DEV chat has no history to compact");
    const output = await this.compactInput(state, state.input, "manual", emit);
    state.input = output;
    state.compactions += 1;
    this.store.save(state);
    return this.status(state);
  }

  async send(
    state: DevChatState,
    message: string,
    emit: (event: DevChatEvent) => void = () => {},
  ): Promise<DevChatTurnResult> {
    const prompt = message.trim();
    if (!prompt) throw new Error("DEV chat message must not be empty");
    const turnId = id("dev_turn");
    let compactions = 0;
    let pendingCompactions = 0;
    let workingInput = [...state.input, ...currentTurnItems(this.cwd, turnId, prompt)];
    let context = this.statusForInput(state, turnId, workingInput);

    if (this.shouldAutoCompact(state, context) && state.input.length > 0) {
      state.input = await this.compactInput(state, state.input, "automatic", emit);
      state.compactions += 1;
      compactions += 1;
      this.store.save(state);
      workingInput = [...state.input, ...currentTurnItems(this.cwd, turnId, prompt)];
      context = this.statusForInput(state, turnId, workingInput);
    }
    if (this.shouldAutoCompact(state, context)) {
      throw new Error(
        `DEV turn still requires ${context.inputTokens.toLocaleString("en-US")} tokens after compaction; `
        + `the selected mode compacts at ${context.autoCompactTokenLimit.toLocaleString("en-US")}`,
      );
    }

    let totalToolCalls = 0;
    const usage: DevChatUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finalText = "";
    for (let round = 0; round < 64; round += 1) {
      const body = requestBody(state, this.cwd, turnId, workingInput, false, this.config.mode === "full");
      const response = await responseRequest(new Request("http://codex-web-gpt.dev/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), this.config, this.adapterFactory, {
        rememberState: false,
        onAdapterEvent: event => observeAdapterEvent(event, emit),
      });
      const envelope = await response.json() as ResponsesEnvelope;
      if (!Array.isArray(envelope.output)) throw new Error("DEV Responses handler returned no output array");
      if (envelope.status !== "completed") throw new Error(responseError(envelope));
      const output = historyOutput(envelope.output!, turnId);
      workingInput.push(...output);
      const roundUsage = usageOf(envelope);
      usage.inputTokens += roundUsage.inputTokens;
      usage.outputTokens += roundUsage.outputTokens;
      usage.totalTokens += roundUsage.totalTokens;
      const calls = toolCalls(output);
      if (calls.length === 0) {
        if (envelope.end_turn !== true) {
          throw new Error("DEV Responses turn completed without tool calls or end_turn=true");
        }
        finalText = outputText(output);
        state.input = workingInput;
        state.turns += 1;
        state.compactions += pendingCompactions;
        state.lastUsage = usage;
        this.store.save(state);
        return {
          text: finalText,
          usage,
          toolCalls: totalToolCalls,
          compactions,
          status: this.status(state),
        };
      }

      totalToolCalls += calls.length;
      for (const call of calls) {
        emit({ type: "tool_call", name: call.name, input: call.input });
        const receipt = simulatedReceipt(state, turnId, call);
        emit({ type: "tool_result", name: call.name, receipt });
        workingInput.push(toolOutput(call, receipt));
      }

      context = this.statusForInput(state, turnId, workingInput);
      if (this.shouldAutoCompact(state, context)) {
        workingInput = await this.compactInput(state, workingInput, "automatic", emit);
        pendingCompactions += 1;
        compactions += 1;
      }
    }
    throw new Error("DEV chat exceeded 64 simulated tool rounds without a final answer");
  }

  async close(): Promise<void> {
    await closeChatGptBrowserWorkers();
  }

  private shouldAutoCompact(state: DevChatState, context: DevContextStatus): boolean {
    return !isLunaDevChatModel(state.model) && context.inputTokens >= context.autoCompactTokenLimit;
  }

  private assertBiggerContextModel(model: DevChatModel): void {
    if (this.features.biggerContext && isLunaDevChatModel(model)) {
      throw new Error(
        "Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget",
      );
    }
  }

  private statusForInput(state: DevChatState, turnId: string, input: unknown[]): DevContextStatus {
    const parsed = parseRequest(requestBody(
      state,
      this.cwd,
      turnId,
      input,
      false,
      this.config.mode === "full",
    ));
    const route = routeChatGptWebRequest(parsed, this.config);
    const inputTokens = estimateChatGptWebInputTokens(parsed, {
      localToolsEnabled: this.config.mode === "full",
      solAvailable: this.config.solAvailable,
      proAvailable: this.config.proAvailable,
    });
    const limits = resolveChatGptWebContextLimits(
      route.backendModel,
      route.adapterEffort,
      this.config,
      this.config.useEnhancedWebSessionMode,
    );
    return {
      model: state.model,
      inputTokens,
      autoCompactTokenLimit: limits.autoCompactTokenLimit,
      contextWindow: limits.contextWindow,
      ...(route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL
        ? { browserInputTokenLimit: CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET }
        : {}),
      percent: Math.round((inputTokens / limits.autoCompactTokenLimit) * 1_000) / 10,
      inputItems: input.length,
    };
  }

  private async compactInput(
    state: DevChatState,
    input: unknown[],
    reason: "automatic" | "manual",
    emit: (event: DevChatEvent) => void,
  ): Promise<unknown[]> {
    if (isLunaDevChatModel(state.model)) {
      throw new Error("ChatGPT Web Luna uses its production rolling checkpoint and does not support a separate compact command");
    }
    const compactTurnId = id("dev_compact_turn");
    emit({ type: "compaction_start", reason, inputItems: input.length });
    const response = await compactRequest(new Request("http://codex-web-gpt.dev/v1/responses/compact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": turnMetadata(state.threadId, compactTurnId, this.cwd),
      },
      body: JSON.stringify({
        model: state.model,
        input,
        instructions: DEV_CHAT_SYSTEM_INSTRUCTIONS,
        store: false,
      }),
    }), this.config, this.adapterFactory);
    if (!response.ok) {
      let message = `DEV compaction failed with HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch {}
      throw new Error(message);
    }
    const body = await response.json() as { output?: unknown };
    if (!Array.isArray(body.output) || body.output.length === 0) {
      throw new Error("DEV compaction returned no replacement history");
    }
    emit({ type: "compaction_done", reason, inputItems: body.output.length });
    return body.output;
  }
}
