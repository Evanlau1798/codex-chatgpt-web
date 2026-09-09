import { ChatGptWebAdapterError } from "./adapter-error";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { ChatGptRetryPrompt } from "./steering";
import type { ChatGptCompletionFenceStart } from "./turn-broker-completion";

const retainedContextArchiveRetryPrompt = (nextIndex: number): string => [
  "The required Codex context archive was not fully read.",
  `Call codex_tool_inventory now with the exact turn_token from the preceding codex_native_turn_binding, query "__codex_context__:${nextIndex}", offset 0, limit 1, and include_schema false.`,
  "Continue through every next_query and verify the shared SHA-256 and final sentinel before any further work or final answer.",
].join(" ");

type TraceSink = (value: string, continuation?: boolean) => void;
type RetryPrompt = string | ChatGptRetryPrompt | undefined;

class RetainedContextArchiveOutputGate {
  constructor(
    private gated: boolean,
    private readonly sinks: { reasoning: TraceSink; commentary: TraceSink },
  ) {}

  reasoning(value: string, continuation?: boolean): void { this.push("reasoning", value, continuation); }
  commentary(value: string, continuation?: boolean): void { this.push("commentary", value, continuation); }

  commit(): void {
    this.gated = false;
  }

  private push(kind: "reasoning" | "commentary", value: string, continuation?: boolean): void {
    if (!this.gated) this.sinks[kind](value, continuation);
  }
}

export class RetainedContextArchiveRecovery {
  private correctionUsed = false;

  constructor(
    private readonly transport: CompiledChatGptWebPrompt["transport"],
    private readonly fence?: {
      begin(): Promise<ChatGptCompletionFenceStart>;
      commit(revision: number): Promise<boolean>;
    },
  ) {}

  outputGate(sinks: { reasoning: TraceSink; commentary: TraceSink }): RetainedContextArchiveOutputGate {
    return new RetainedContextArchiveOutputGate(this.transport === "retained-system-archive", sinks);
  }

  async completion(revision: number | undefined): Promise<
    { status: "complete" } | { status: "wait"; revision?: number } | { status: "retry"; prompt: string }
  > {
    if (!this.fence) return { status: "complete" };
    if (revision !== undefined) {
      return await this.fence.commit(revision) ? { status: "complete" } : { status: "wait" };
    }
    const start = await this.fence.begin();
    if ("revision" in start) return { status: "wait", revision: start.revision };
    if (this.transport !== "retained-system-archive" || start.blocked !== "context_archive") {
      return { status: "wait" };
    }
    if (!this.correctionUsed) {
      this.correctionUsed = true;
      return { status: "retry", prompt: retainedContextArchiveRetryPrompt(start.nextIndex) };
    }
    throw new ChatGptWebAdapterError("ChatGPT did not read the required context archive after one same-surface correction", {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_context_archive_unread",
      retryable: false,
      retireSession: true,
    });
  }

  async selectRetry(
    completionRetry: string | undefined,
    preemptiveRetry: string | undefined,
    answerRetry: () => RetryPrompt | Promise<RetryPrompt>,
  ): Promise<{ prompt: RetryPrompt; pendingPreemptiveRetry?: string }> {
    if (completionRetry) {
      return { prompt: preemptiveRetry ? `${completionRetry}\n\nAfter the archive is ready:\n${preemptiveRetry}` : completionRetry };
    }
    if (preemptiveRetry) return { prompt: preemptiveRetry };
    return { prompt: await answerRetry() };
  }
}
