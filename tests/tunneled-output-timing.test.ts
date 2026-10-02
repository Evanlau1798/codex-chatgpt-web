import { afterEach, expect, spyOn, test } from "bun:test";
import { runChatGptTunneledOutputTurn } from "../src/adapters/chatgpt-web/tunneled-output-turn";
import type { BrokerTurnOutputEvent } from "../src/adapters/chatgpt-web/turn-broker-protocol";

afterEach(() => { spyOn(Date, "now").mockRestore(); });
const final: BrokerTurnOutputEvent = { sequence: 1, kind: "final", text: "atomic answer" };
function output() {
  return { next: (sequence: number, signal?: AbortSignal) => sequence === 0 ? Promise.resolve(final)
    : new Promise<BrokerTurnOutputEvent>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), reset: async () => {}, seal: async () => true };
}

test("final timing distinguishes observation cost and running wait without early delivery", async () => {
  let clock = 1_000, reads = 0, delivered = false;
  const reports: unknown[] = [];
  spyOn(Date, "now").mockImplementation(() => clock);
  const result = await runChatGptTunneledOutputTurn({
    output: output(), attempt: 1, pollMs: 1,
    observe: async () => { expect(delivered).toBe(false); clock += 200; reads++;
      return { running: reads === 1, responsePresent: true, toolCallsInFlight: false }; },
    completionFence: { begin: async () => 7, commit: async () => true },
    onFinal: text => { expect(text).toBe("atomic answer"); delivered = true; },
    onFinalTiming: (value: unknown) => reports.push(value),
  } as Parameters<typeof runChatGptTunneledOutputTurn>[0]);
  expect(result).toEqual({ status: "complete", answer: "atomic answer" });
  expect(reports).toEqual([{ status: "complete", elapsedMs: 600, readerResolvedToConsumedMs: 0,
    observations: 3, runningObservations: 1, toolObservations: 0, totalObservationMs: 600,
    maxObservationMs: 200, firstStoppedMs: 400, lastRunningMs: 200 }]);
});

test("timing sink failure cannot change successful atomic completion", async () => {
  const result = await runChatGptTunneledOutputTurn({ output: output(), attempt: 1, pollMs: 1,
    observe: async () => ({ running: false, responsePresent: true }), onFinal: () => {},
    onFinalTiming: () => { throw new Error("diagnostic sink unavailable"); },
  } as Parameters<typeof runChatGptTunneledOutputTurn>[0]);
  expect(result.status).toBe("complete");
});
