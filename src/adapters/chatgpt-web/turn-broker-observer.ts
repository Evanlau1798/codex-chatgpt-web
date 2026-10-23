import { withAbort } from "./runtime-lifecycle";
import type { TurnChannel } from "./turn-broker-state";

export function setTurnObserverConnected(channel: TurnChannel, connected: boolean): boolean {
  if (channel.completionCommitted || channel.outputFinalSequence !== undefined || channel.safe) return false;
  if (!connected && (channel.finalizationOnly || channel.outputSealed)) return false;
  if (!connected && !channel.observerPause) {
    let resume!: () => void;
    const ready = new Promise<void>(resolve => { resume = resolve; });
    channel.observerPause = { ready, resume };
    channel.activityRevision++;
  } else if (connected && channel.observerPause) {
    const paused = channel.observerPause;
    channel.observerPause = undefined;
    channel.activityRevision++;
    paused.resume();
  }
  return true;
}

export async function waitForTurnObserver(channel: TurnChannel, signal?: AbortSignal): Promise<void> {
  while (channel.observerPause) await withAbort(channel.observerPause.ready, signal);
}
