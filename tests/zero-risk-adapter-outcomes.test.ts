import { expect, test } from "bun:test";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { AdapterEvent } from "../src/types";
import { request, binding, provider, noManualTerminal } from "./zero-risk-adapter-fixture";

test("a lost launcher completion acknowledgement cannot replace an authoritative Zero Risk answer", async () => {
  const config = provider("completion-ack-lost");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  const endStatuses: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() {},
    waitTerminal() {
      broker.startSafeTurn(exactBinding!.request_id);
      return noManualTerminal();
    },
    async markStarted() {
      broker.completeSafeTurn(exactBinding!.request_id, "Answer completed before the acknowledgement was lost");
    },
    async end(_path, activity) {
      endStatuses.push(activity.status);
      throw new Error("local completion acknowledgement was lost");
    },
    async cancel() {},
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_completion_ack_lost"),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(endStatuses).toEqual(["completed"]);
    expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta" && event.phase === "final_answer"
    )).map(event => event.text).join(""))
      .toBe("Answer completed before the acknowledgement was lost");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("a Zero Risk launcher failure remains failed when its own capability cleanup retires the broker", async () => {
  const config = provider("failed-cleanup");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() { throw new Error("synthetic launcher observation failure"); },
    waitTerminal: noManualTerminal,
    async markStarted() {},
    async end(_path, activity) { ended.push(activity.status); },
    async cancel() {},
  };
  try {
    await expect(createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_failed_cleanup"),
      { headers: new Headers() },
      () => {},
    )).rejects.toThrow("synthetic launcher observation failure");
    expect(ended).toEqual(["failed"]);
    expect(() => broker.startSafeTurn(exactBinding!.request_id))
      .toThrow("invalid, expired, or revoked");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});
