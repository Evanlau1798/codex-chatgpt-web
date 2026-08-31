import type { BrowserTurn } from "./browser-worker";

export function forwardLauncherHelperProgress(
  turn: BrowserTurn,
  supported: boolean,
  stop: AbortSignal,
  send: (message: unknown) => Promise<void>,
): void {
  const progress = turn.externalProgress;
  if (!progress) return;
  if (!supported) {
    console.warn(
      `[chatgpt-web] browser turn ${turn.traceId} runs without an MCP progress mirror:`
      + " the launcher browser helper predates the progress frame",
    );
    return;
  }
  void (async () => {
    let revision = 0;
    while (!stop.aborted) {
      const snapshot = await progress.waitForChange(revision, stop);
      revision = snapshot.revision;
      if (stop.aborted) return;
      await send({ type: "progress", id: turn.traceId, snapshot });
    }
  })().catch(error => {
    if (stop.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    console.warn(
      `[chatgpt-web] browser turn ${turn.traceId} lost its MCP progress mirror:`
      + ` ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
