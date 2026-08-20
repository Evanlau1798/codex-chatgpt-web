import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  parseLauncherHelperMessage,
  type LauncherHelperMessage,
} from "./launcher-helper-protocol";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";

interface PendingTurn {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  sent?: boolean;
  prepared?: CompiledChatGptWebPrompt & { release: () => void };
  acknowledgeRetry?: () => void;
  localFailure?: Error;
  preemptiveRetryRequested?: boolean;
}

export class LauncherBrowserHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pending = new Map<string, PendingTurn>();

  constructor(private readonly config: ResolvedBrowserConfig) {}

  async run(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    await this.ensureChild();
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    return new Promise<string>((resolveResult, rejectResult) => {
        if (this.pending.has(turn.traceId)) {
          rejectResult(new Error(`Duplicate launcher browser turn: ${turn.traceId}`));
          return;
        }
        const pending: PendingTurn = {
          turn,
          resolve: resolveResult,
          reject: rejectResult,
        };
        this.pending.set(turn.traceId, pending);
        if (turn.abortSignal) {
          const abortListener = () => {
            if (!pending.sent) {
              this.finishWithError(
                turn.traceId,
                new DOMException("ChatGPT web turn aborted", "AbortError"),
                pending,
              );
              return;
            }
            void this.send({ type: "abort", id: turn.traceId }).catch(error => {
              this.finishWithError(
                turn.traceId,
                error instanceof Error ? error : new Error(String(error)),
                pending,
              );
            });
          };
          pending.abortListener = abortListener;
          turn.abortSignal.addEventListener("abort", abortListener, { once: true });
          if (turn.abortSignal.aborted) {
            abortListener();
            return;
          }
        }
        // Setting this before the synchronous write call makes an abort either prevent dispatch or
        // queue an `abort` after the `run` frame; it can never overtake the run frame in the pipe.
        pending.sent = true;
        void this.send({
          type: "run",
          id: turn.traceId,
          config: {
            appName: this.config.appName,
            browserHostDescriptorPath: this.config.browserHostDescriptorPath!,
            turnTimeoutMs: this.config.turnTimeoutMs,
            autoApproveToolCalls: this.config.autoApproveToolCalls,
          },
          turn: {
            traceId: turn.traceId,
            modelId: turn.modelId,
            reasoning: turn.reasoning,
            capabilities: turn.capabilities,
            ...(turn.nativeConnector ? { nativeConnector: true } : {}),
            ...(turn.prepareResume ? { resumeAvailable: true } : {}),
            ...(turn.retainConversation ? { retainConversation: true } : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
          },
        }).catch(error => this.finishWithError(
          turn.traceId, error instanceof Error ? error : new Error(String(error)), pending,
        ));
      });
  }

  requestPreemptiveRetry(traceId: string, prompt: string): boolean {
    const pending = this.pending.get(traceId);
    if (!pending?.sent || pending.localFailure || pending.preemptiveRetryRequested || !prompt.trim()) return false;
    pending.preemptiveRetryRequested = true;
    void this.send({ type: "preempt_retry", id: traceId, prompt }).catch(error => this.abortWithLocalFailure(
      traceId,
      error instanceof Error ? error : new Error(String(error)),
      pending,
    ));
    return true;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const id of [...this.pending.keys()]) {
      this.finishWithError(id, new DOMException("Launcher browser helper is closing", "AbortError"));
    }
    if (!child) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
  }

  private async ensureChild(): Promise<void> {
    if (this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.ready) {
      return this.ready;
    }
    const descriptor = readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!);
    const child = spawn(descriptor.helper.executable, [descriptor.helper.script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => this.handleLine(child, line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
    const failChild = (error: Error) => {
      const owned = this.child === child;
      this.handleExit(child, error);
      if (owned && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
        void this.terminateChild(child, 0).catch(cleanupError => {
          console.error(
            `[chatgpt-web-helper] process-error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
      }
    };
    child.once("error", failChild);
    child.stdin.once("error", error => failChild(new Error(
      `Launcher browser helper input failed: ${error instanceof Error ? error.message : String(error)}`,
    )));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(
      `Launcher browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    const timer = setTimeout(() => {
      if (this.child === child) this.readyReject?.(new Error("Launcher browser helper did not become ready"));
    }, 15_000);
    try {
      await this.ready;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
      try {
        await this.terminateChild(child, 500);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; launcher browser helper cleanup failed: ${cleanup}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: LauncherHelperMessage;
    try { message = parseLauncherHelperMessage(line); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleExit(child, new Error(`Launcher browser helper emitted invalid protocol data: ${detail}`));
      void this.terminateChild(child, 0).catch(error => {
        console.error(`[chatgpt-web-helper] invalid-protocol cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (message.type === "ready") {
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      if (message.event === "heartbeat") {
        this.invokeEventCallback(message.id, pending, () => pending.turn.onHeartbeat?.());
      }
      else if (message.event === "submitted") {
        this.invokeEventCallback(message.id, pending, () => pending.turn.onSubmitted?.());
      }
      else if (message.event === "retry_submitted") {
        const acknowledge = pending.acknowledgeRetry;
        pending.acknowledgeRetry = undefined;
        if (acknowledge) this.invokeEventCallback(message.id, pending, acknowledge);
      }
      else if (message.event === "prepared_selected") {
        const prepare = message.reused ? pending.turn.prepareResume : pending.turn.prepare;
        void Promise.resolve().then(() => prepare?.())
          .then(prepared => {
            if (!prepared) throw new Error("Launcher browser helper selected an unavailable resume prompt");
            if (this.pending.get(message.id) !== pending) {
              prepared.release();
              return;
            }
            pending.prepared = prepared;
            return Promise.resolve(pending.turn.onPreparedSelected?.(message.reused))
              .then(() => {
                if (this.pending.get(message.id) !== pending) return;
                return this.send({
                  type: "prepared_selected_ack",
                  id: message.id,
                  prepared: { text: prepared.text, images: prepared.images } satisfies CompiledChatGptWebPrompt,
                });
              });
          })
          .catch(error => {
            if (this.pending.get(message.id) === pending) this.abortWithLocalFailure(
              message.id,
              error instanceof Error ? error : new Error(String(error)),
              pending,
            );
          });
      }
      else if (message.event === "answer") {
        void Promise.resolve().then(() => pending.turn.retryPromptForAnswer?.(message.text, message.attempt))
          .then(prompt => {
            if (this.pending.get(message.id) !== pending) return;
            if (!prompt) return this.send({ type: "answer_retry", id: message.id });
            const retry = typeof prompt === "string" ? { text: prompt } : prompt;
            pending.acknowledgeRetry = retry.onSubmitted;
            return this.send({
              type: "answer_retry", id: message.id, prompt: retry.text,
              ...(retry.onSubmitted ? { acknowledge: true } : {}),
              ...(retry.replaceCandidate ? { replaceCandidate: true } : {}),
            });
          })
          .catch(error => {
            if (this.pending.get(message.id) === pending) this.abortWithLocalFailure(
              message.id,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
      else if (message.event === "error_retry") {
        const failure = message.status !== undefined
          ? new ChatGptWebAdapterError(message.text, {
            status: message.status,
            errorType: message.errorType!,
            code: message.code!,
            retryable: message.retryable!,
            retireSession: message.retireSession === true,
          })
          : new Error(message.text);
        void Promise.resolve().then(() => pending.turn.retryPromptForError?.(failure, message.attempt))
          .then(prompt => {
            if (this.pending.get(message.id) !== pending) return;
            if (!prompt) return this.send({ type: "answer_retry", id: message.id });
            const retry = typeof prompt === "string" ? { text: prompt } : prompt;
            pending.acknowledgeRetry = retry.onSubmitted;
            return this.send({
              type: "answer_retry", id: message.id, prompt: retry.text,
              ...(retry.onSubmitted ? { acknowledge: true } : {}),
              ...(retry.replaceCandidate ? { replaceCandidate: true } : {}),
            });
          })
          .catch(error => {
            if (this.pending.get(message.id) === pending) this.abortWithLocalFailure(
              message.id,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
      else if (message.event === "luna_checkpoint") {
        if (!pending.turn.captureLunaCheckpoint || !pending.turn.onLunaCheckpoint) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper emitted an unexpected Luna checkpoint"),
          );
          return;
        }
        this.invokeEventCallback(message.id, pending, () => {
          pending.turn.onLunaCheckpoint!({ checkpoint: message.checkpoint, answerHash: message.answerHash });
        });
      }
      else if (message.event === "reasoning" && message.text) {
        const text = message.text;
        this.invokeEventCallback(message.id, pending, () => {
          pending.turn.onReasoningSummary?.(text, message.continuation === true);
        });
      }
      else if (message.event === "commentary" && message.text) {
        const text = message.text;
        this.invokeEventCallback(message.id, pending, () => {
          pending.turn.onCommentary?.(text, message.continuation === true);
        });
      }
      else if (message.event === "text" && message.text) {
        const text = message.text;
        this.invokeEventCallback(message.id, pending, () => pending.turn.onTextDelta(text));
      }
      return;
    }
    if (message.type === "result") {
      this.finish(message.id);
      if (pending.localFailure) pending.reject(pending.localFailure);
      else pending.resolve(message.text);
    } else if (message.type === "error") {
      const error = message.status !== undefined
        ? new ChatGptWebAdapterError(message.message, {
          status: message.status,
          errorType: message.errorType!,
          code: message.code!,
          retryable: message.retryable!,
          retireSession: message.retireSession === true,
        })
        : message.name === "AbortError"
          ? new DOMException(message.message, "AbortError")
          : new Error(message.message);
      this.finish(message.id);
      pending.reject(pending.localFailure ?? error);
    }
  }

  private invokeEventCallback(id: string, pending: PendingTurn, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      if (this.pending.get(id) === pending) {
        this.abortWithLocalFailure(
          id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        );
      }
    }
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.abortListener && pending.turn.abortSignal) {
      pending.turn.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.prepared?.release();
    this.pending.delete(id);
  }

  private finishWithError(id: string, error: Error, expected?: PendingTurn): void {
    const pending = this.pending.get(id);
    if (!pending || (expected && pending !== expected)) return;
    this.finish(id);
    pending.reject(error);
  }

  private abortWithLocalFailure(id: string, error: Error, expected?: PendingTurn): void {
    const pending = this.pending.get(id);
    if (!pending || (expected && pending !== expected) || pending.localFailure) return;
    pending.localFailure = error;
    if (!pending.sent) {
      this.finishWithError(id, error, pending);
      return;
    }
    void this.send({ type: "abort", id }).catch(cleanupError => {
      this.finishWithError(id, new Error(
        `${error.message}; launcher browser helper cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      ), pending);
    });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.ready = undefined;
    this.child = undefined;
    for (const id of [...this.pending.keys()]) {
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end",
        traceId: id,
        helperPid: child.pid!,
        status: "failed",
        message: "Launcher browser helper exited before completing the turn",
      }).catch(controlError => {
        console.error(
          `[chatgpt-web-helper] failed to release launcher turn ${id}: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      });
      this.finishWithError(id, error);
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolveExit => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, gracefulTimeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(child, gracefulTimeoutMs)) return;
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused termination");
    }
    if (await this.waitForExit(child, 2_000)) return;
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused forced termination");
    }
    if (!await this.waitForExit(child, 2_000)) {
      throw new Error("Launcher browser helper did not exit after forced termination");
    }
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child
      || child.killed
      || child.exitCode !== null
      || child.signalCode !== null) {
      return Promise.reject(new Error("Launcher browser helper is not running"));
    }
    return this.sendTo(child, message);
  }

  private async sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Launcher browser helper input is closed");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(encoded, error => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }
}
