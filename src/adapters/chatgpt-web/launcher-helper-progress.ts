import type { BrowserTurn } from "./browser-worker";

export function forwardLauncherHelperProgress(
  turn: BrowserTurn,
  features: ReadonlySet<string>,
  stop: AbortSignal,
  send: (message: unknown) => Promise<void>,
  fail?: (error: Error) => void,
): void {
  const progress = turn.externalProgress;
  if (progress && !features.has("progress")) {
    console.warn(
      `[chatgpt-web] browser turn ${turn.traceId} runs without an MCP progress mirror:`
      + " the launcher browser helper predates the progress frame",
    );
  } else if (progress) {
    void (async () => {
      let revision = 0;
      while (!stop.aborted) {
        const snapshot = await progress.waitForChange(revision, stop);
        revision = snapshot.revision;
        if (!stop.aborted) await send({ type: "progress", id: turn.traceId, snapshot });
      }
    })().catch(error => reportForwardingFailure(turn.traceId, "MCP progress", stop, error));
  }
  if (!turn.tunneledOutput) return;
  void (async () => {
    let sequence = 0;
    while (!stop.aborted) {
      const output = await turn.tunneledOutput!.next(sequence, stop);
      sequence = output.sequence;
      if (!stop.aborted) await send({ type: "tunneled_output", id: turn.traceId, output });
    }
  })().catch(error => {
    const failure = reportForwardingFailure(turn.traceId, "tunneled output", stop, error);
    if (failure) fail?.(failure);
  });
}

function reportForwardingFailure(traceId: string, channel: string, stop: AbortSignal, error: unknown): Error | undefined {
  if (stop.aborted || (error instanceof DOMException && error.name === "AbortError")) return undefined;
  const failure = error instanceof Error ? error : new Error(String(error));
  console.warn(`[chatgpt-web] browser turn ${traceId} lost its ${channel} mirror: ${failure.message}`);
  return failure;
}
