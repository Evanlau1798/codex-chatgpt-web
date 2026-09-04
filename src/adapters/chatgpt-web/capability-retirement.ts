import type { TurnBrokerOwner } from "./turn-broker";
import type { ChatGptExternalTurnProgress } from "./turn-progress";

/** Broker retirement revokes tool delivery, but never manufactures model progress. */
export function observeCapabilityRetirement(
  broker: TurnBrokerOwner,
  token: string,
  progress: ChatGptExternalTurnProgress,
  controller: AbortController,
  ownerSettled: () => boolean,
): void {
  void broker.waitForRetirement(token).then(
    () => {
      const error = new Error("Codex Native retired the turn binding before its tool work completed");
      progress.retire(error);
      if (!ownerSettled() && !controller.signal.aborted) controller.abort(error);
    },
    cause => {
      const error = new Error("ChatGPT could not observe Codex Native turn retirement", { cause });
      progress.retire(error);
      if (!controller.signal.aborted) controller.abort(error);
    },
  );
}
