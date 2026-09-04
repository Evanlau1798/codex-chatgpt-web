import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { expandUserPath } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { retainedConversationRelease } from "./adapter-runtime-config";
import { canonicalizeCompactionHandoff } from "./compaction-handoff";
import type { ChatGptTurnEnvironment } from "./environment";
import type { ChatGptWebCapabilities } from "./model";
import { compileChatGptWebPrompt } from "./prompt";
import { deferred } from "./runtime-lifecycle";
import { retainedConversationResumeRequest } from "./steering";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import type { TurnBrokerOwner } from "./turn-broker";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptConversationKey,
  type ChatGptTurnRuntime,
} from "./turn-execution";

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

export const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function manualError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408, errorType: "invalid_request_error", code: "manual_handoff_timeout", retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return terminalError("cancelled");
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502, errorType: "server_error", code: "manual_launcher_failed", retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function terminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    status === "cancelled"
      ? "The Zero Risk browser turn was cancelled in the Launcher"
      : "The Zero Risk browser tab failed before ChatGPT completed the turn",
    status === "cancelled"
      ? { status: 409, errorType: "invalid_request_error", code: "manual_turn_cancelled", retryable: false }
      : { status: 502, errorType: "server_error", code: "manual_launcher_failed", retryable: false },
  );
}

function cancellable(run: Promise<string>, controller: AbortController) {
  let rejectCancellation!: (error: Error) => void;
  let rejected = false;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  return {
    browser: Promise.race([run, cancellation]),
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      if (reason && !rejected) {
        rejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

interface ZeroRiskRuntimeOptions {
  provider: CodexProviderConfig;
  broker: TurnBrokerOwner;
  capabilities: ChatGptWebCapabilities;
  executionNamespace: string;
  control: ChatGptZeroRiskManualControl;
  timeoutMs?: number;
}

export function createZeroRiskRuntimeStarter(options: ZeroRiskRuntimeOptions) {
  const configuredPath = options.provider.chatgptWeb?.browserHost === "launcher"
    ? options.provider.chatgptWeb.browserHostDescriptorPath
    : undefined;
  if (!configuredPath) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
  if (!options.capabilities.localToolsEnabled) throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
  const descriptorPath = resolve(expandUserPath(configuredPath));

  return (
    parsed: CodexParsedRequest,
    environment: ChatGptTurnEnvironment | undefined,
    traceId: string,
  ): ChatGptTurnRuntime => {
    if (!isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
      throw new Error("ChatGPT Zero Risk requires the Zero Risk Web model route");
    }
    if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
    const token = deferred<string>();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const externalProgress = new ChatGptExternalTurnProgress();
    const browserAbort = new AbortController();
    const surfaceNonce = randomBytes(32).toString("base64url");
    const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
    const conversationKey = parsed._compactionRequest
      ? undefined
      : chatGptConversationKey(parsed, options.executionNamespace);
    const resume = conversationKey ? retainedConversationResumeRequest(parsed) : undefined;
    const release = options.control === launcherZeroRiskManualControl
      ? retainedConversationRelease(options.provider, conversationKey)
      : undefined;
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    let activeToken: string | undefined;
    let launcherStartAttempted = false;
    let launcherEnded = false;

    const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
      if (!launcherStartAttempted || launcherEnded) return;
      await options.control.end(descriptorPath, {
        ...owner,
        status,
        ...(status === "completed" && conversationKey ? { retain: true } : {}),
      });
      launcherEnded = true;
    };
    const run = async (): Promise<string> => {
      try {
        activeToken = await options.broker.registerSafe(
          environment,
          surfaceNonce,
          options.timeoutMs === undefined ? undefined : options.timeoutMs + 60_000,
          traceId,
        );
        const full = compileChatGptWebPrompt(parsed, options.capabilities, activeToken, { manualControl: true });
        const suffix = resume
          ? compileChatGptWebPrompt(resume, options.capabilities, activeToken, { manualControl: true })
          : undefined;
        if (full.multipart || suffix?.multipart) {
          throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
            status: 409, errorType: "invalid_request_error", code: "manual_multipart_unsupported", retryable: false,
          });
        }
        if (!parsed._compactionRequest) trace.push({
          kind: "commentary",
          text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the `Codex Zero Risk` plugin and the model you want, send the prompt, then confirm it was sent in the launcher.",
        });
        launcherStartAttempted = true;
        await options.control.start(descriptorPath, {
          ...owner,
          prompt: full.text,
          ...(suffix ? { resumePrompt: suffix.text } : {}),
          ...(conversationKey ? { conversationKey } : {}),
        });
        token.resolve(activeToken);
        await options.control.waitSent(descriptorPath, owner, { abortSignal: browserAbort.signal });
        await options.broker.confirmSafeTurnSent(activeToken, surfaceNonce);
        submission.phase = "accepted";
        const terminalAbort = new AbortController();
        const onAbort = () => terminalAbort.abort();
        browserAbort.signal.addEventListener("abort", onAbort, { once: true });
        const terminalFailure = options.control.waitTerminal(
          descriptorPath,
          owner,
          { abortSignal: terminalAbort.signal },
        ).then(observed => Promise.reject(terminalError(observed.status))).catch(error => (
          terminalAbort.signal.aborted ? new Promise<never>(() => {}) : Promise.reject(error)
        ));
        try {
          await Promise.race([options.broker.waitForSafeStart(activeToken, browserAbort.signal), terminalFailure]);
          await options.control.markStarted(descriptorPath, owner);
          const completed = await Promise.race([
            options.broker.waitForSafeCompletion(activeToken, browserAbort.signal),
            terminalFailure,
          ]);
          const answer = parsed._compactionRequest ? canonicalizeCompactionHandoff(parsed, completed) : completed;
          if (answer === undefined) throw new Error("ChatGPT returned an invalid structured compaction handoff");
          text.push(answer);
          await finishLauncher("completed");
          return answer;
        } finally {
          terminalAbort.abort();
          browserAbort.signal.removeEventListener("abort", onAbort);
        }
      } catch (error) {
        const normalized = manualError(error);
        if (activeToken) await Promise.resolve(options.broker.revoke(activeToken, normalized)).catch(() => {});
        await finishLauncher(browserAbort.signal.aborted ? "aborted" : "failed").catch(controlError => {
          console.error(`[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`);
        });
        throw normalized;
      }
    };
    const turn = cancellable(run(), browserAbort);
    void turn.browser.catch(error => token.reject(error instanceof Error ? error : new Error(String(error))));
    return {
      mode: "tools",
      token: token.promise,
      browser: turn.browser,
      physicalSettlement: turn.physicalSettlement,
      trace,
      text,
      externalProgress,
      usageInput: parsed,
      manualControl: { surfaceNonce },
      submission,
      ...(conversationKey ? { conversationKey } : {}),
      ...(release ? { release } : {}),
      cancel(reason?: Error) {
        turn.cancel(reason);
        if (activeToken) void Promise.resolve(options.broker.revoke(activeToken, reason)).catch(() => {});
      },
    };
  };
}
