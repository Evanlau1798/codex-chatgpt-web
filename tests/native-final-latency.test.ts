import { expect, spyOn, test } from "bun:test";
import { runChatGptTunneledOutputTurn } from "../src/adapters/chatgpt-web/tunneled-output-turn";
import type { BrokerTurnOutputEvent } from "../src/adapters/chatgpt-web/turn-broker-protocol";

test("accepted atomic final and its fence confirmation do not wait for an observation poll", async () => {
  let accepted = false;
  const waits: number[] = [];
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    if (accepted) waits.push(ms);
    return schedule(callback, 0);
  }) as typeof setTimeout);
  const order: string[] = [];
  try {
    const result = await runChatGptTunneledOutputTurn({
      output: finalOutput(), attempt: 1, pollMs: 250,
      onProgress: () => { accepted = true; },
      observe: async () => { order.push("observe"); return { running: false, responsePresent: true }; },
      completionFence: {
        begin: async () => { order.push("begin"); return 7; },
        commit: async revision => { expect(revision).toBe(7); order.push("commit"); return true; },
      },
      onFinal: text => { expect(text).toBe("Complete."); order.push("final"); },
    });
    expect(result).toEqual({ status: "complete", answer: "Complete." });
    expect(order).toEqual(["observe", "begin", "observe", "commit", "final"]);
    expect(waits.filter(ms => ms > 0)).toEqual([]);
  } finally { timer.mockRestore(); }
});

test.each(["generation", "tools", "revision", "abort"] as const)(
  "immediate final confirmation still rejects a late %s race", async race => {
    let observations = 0;
    let begins = 0;
    let commits = 0;
    const controller = new AbortController();
    const answers: string[] = [];
    const result = runChatGptTunneledOutputTurn({
      output: finalOutput(), attempt: 1, pollMs: 1, signal: controller.signal,
      observe: async () => {
        observations++;
        if (observations === 2 && race === "abort") controller.abort();
        return { running: observations === 2 && race === "generation", responsePresent: true,
          toolCallsInFlight: observations === 2 && race === "tools" };
      },
      completionFence: {
        begin: async () => ++begins,
        commit: async () => { commits++; return race !== "revision" || commits > 1; },
      },
      onFinal: text => { answers.push(text); },
    });
    if (race === "abort") {
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(answers).toEqual([]);
    } else {
      expect(await result).toEqual({ status: "complete", answer: "Complete." });
      expect(answers).toEqual(["Complete."]);
      expect(begins).toBe(2);
      expect(observations).toBeGreaterThanOrEqual(4);
    }
  },
);

function finalOutput() {
  return {
    next: (after: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent> => after === 0
      ? Promise.resolve({ sequence: 1, kind: "final", text: "Complete." })
      : new Promise((_, reject) => signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")), { once: true })),
    reset: async () => {}, seal: async () => true,
  };
}
