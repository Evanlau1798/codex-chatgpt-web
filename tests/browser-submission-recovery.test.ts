import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import {
  ChatGptBrowserWorker, browserStageTimeouts, CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
  throwIfChatGptSessionFailureAlert, throwIfChatGptRateLimitDialog,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser-observation";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-session";
import { activateChatGptSendControl, readChatGptAssistantTurnState } from "../src/adapters/chatgpt-web/response-turn-boundary";
import { chatGptSuspensionClock } from "../src/adapters/chatgpt-web/browser-stage-lifecycle";

type Recovery = (attempt: number, cause: Error, signal?: AbortSignal) => Promise<Page>;
type State = { count: number; lastId?: string };
type Baseline = { userTurns: Locator; responseTurns: Locator; initialUserTurnCount: number; initialResponseTurnCount: number };
interface Worker {
  activeComposer(page: Page): Promise<unknown>;
  waitForTurnDomMutation(page: Page): Promise<void>;
  sendAttachedPrompt(page: Page, baseline: Baseline, initial: State, capture?: unknown,
    signal?: AbortSignal, activated?: () => void, progress?: ChatGptExternalTurnProgress, recover?: Recovery): Promise<string>;
  waitForSubmissionAccepted(page: Page, users: Locator, responses: Locator, response: Locator,
    userCount: number, initial: State, signal?: AbortSignal, progress?: ChatGptExternalTurnProgress,
    initialRevision?: number, recover?: Recovery): Promise<string>;
  waitForNewAssistantTurn(page: Page, responses: Locator, initial: State, deadline?: number,
    signal?: AbortSignal, progress?: ChatGptExternalTurnProgress, grace?: number, recover?: Recovery): Promise<Locator>;
}

function surface(read: () => Promise<State>) {
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false, count: async () => 0,
  };
  const users = { count: async () => 1 } as Locator;
  const selected: string[] = [];
  const assistant = { ...hidden } as unknown as Locator;
  const responses = {
    evaluateAll: read, nth: () => assistant, page: () => page,
  } as unknown as Locator;
  const page = {
    isClosed: () => false,
    locator: (selector: string) => selector.includes('data-message-author-role="assistant"')
      ? responses : selector.includes('data-message-author-role="user"') ? users : hidden,
    getByTestId: (id: string) => { selected.push(id); return assistant; },
  } as unknown as Page;
  const baseline = { userTurns: users, responseTurns: responses, initialUserTurnCount: 1, initialResponseTurnCount: 1 };
  return { page, responses, assistant, baseline, selected };
}

const initial = { count: 1, lastId: "conversation-turn-old" };
const timeout = () => Promise.reject(new ChatGptBrowserObservationTimeoutError(5_000));
const worker = () => Object.create(ChatGptBrowserWorker.prototype) as Worker;
async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("test observation did not settle")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}
const accepted = (instance: Worker, fixture: ReturnType<typeof surface>, signal?: AbortSignal,
  progress?: ChatGptExternalTurnProgress, recover?: Recovery) => instance.waitForSubmissionAccepted(
    fixture.page, fixture.baseline.userTurns, fixture.responses, fixture.assistant, 1, initial,
    signal, progress, 0, recover,
  );

test("accepted send rebinds observation once without sending the prompt twice", async () => {
  const first = surface(timeout);
  const next = surface(async () => ({ count: 1, lastId: "conversation-turn-new" }));
  const instance = worker();
  let presses = 0;
  let activated = 0;
  let recoveries = 0;
  instance.activeComposer = async () => ({ locator: () => ({ getByTestId: () => ({
    waitFor: async () => {}, isEnabled: async () => true, press: async () => { presses++; },
  }) }) });
  const signal = new AbortController().signal;
  const evidence = await instance.sendAttachedPrompt(first.page, first.baseline, initial, undefined,
    signal, () => { activated++; }, new ChatGptExternalTurnProgress(), async (attempt, cause, caller) => {
      expect(attempt).toBe(1);
      expect(cause).toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
      expect(caller).toBe(signal);
      recoveries++;
      return next.page;
    });
  expect(evidence).toBe("assistant_turn");
  expect([presses, activated, recoveries]).toEqual([1, 1, 1]);
});

test("submission recovery is bounded and propagates ordinary failures without retry", async () => {
  const fixture = surface(timeout);
  let rebinds = 0;
  await expect(accepted(worker(), fixture, undefined, undefined, async () => {
    rebinds++;
    return fixture.page;
  })).rejects.toThrow("after 2 same-page rebinds");
  expect(rebinds).toBe(2);
  const failure = new Error("invalid response identity");
  await expect(accepted(worker(), surface(async () => { throw failure; }), undefined, undefined,
    async () => { rebinds++; return fixture.page; })).rejects.toBe(failure);
  expect(rebinds).toBe(2);
});

test("submission recovery preserves the original MCP batch revision", async () => {
  const fixture = surface(timeout);
  const progress = new ChatGptExternalTurnProgress();
  const evidence = await accepted(worker(), fixture, undefined, progress, async () => {
    progress.recordToolBatch(1);
    return fixture.page;
  });
  expect(evidence).toBe("mcp_tool_call");
});

test("assistant recovery binds the new stable identity on the rebound page", async () => {
  const first = surface(timeout);
  const next = surface(async () => ({ count: 1, lastId: "conversation-turn-new" }));
  expect(await worker().waitForNewAssistantTurn(first.page, first.responses, initial, undefined,
    undefined, undefined, 180_000, async () => next.page)).toBe(next.assistant);
  expect(next.selected).toEqual(["conversation-turn-new"]);
});

test("cancel while a DOM probe is pending does not wait for the probe or start recovery", async () => {
  const fixture = surface(() => new Promise(() => {}));
  const controller = new AbortController();
  let recoveries = 0;
  const result = accepted(worker(), fixture, controller.signal, undefined, async () => {
    recoveries++;
    return fixture.page;
  });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await expect(bounded(result, 500)).rejects.toMatchObject({ name: "AbortError" });
    expect(recoveries).toBe(0);
  } finally { clearTimeout(timer); }
}, 1_000);

test("a genuinely stalled submission probe reaches the bounded observation timeout", async () => {
  const fixture = surface(() => new Promise(() => {}));
  await expect(bounded(accepted(worker(), fixture), 6_000)).rejects.toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
}, 6_500);

test("a timed-out mutation wait releases its MCP progress subscription", async () => {
  const fixture = surface(async () => initial);
  const instance = worker();
  instance.waitForTurnDomMutation = () => new Promise(() => {});
  const progress = new ChatGptExternalTurnProgress();
  const signals: AbortSignal[] = [];
  const wait = progress.waitForChange.bind(progress);
  progress.waitForChange = (revision, signal) => {
    if (signal) signals.push(signal);
    return wait(revision, signal);
  };
  await expect(bounded(accepted(instance, fixture, undefined, progress), 6_000))
    .rejects.toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every(signal => signal.aborted)).toBeTrue();
}, 6_500);

test("MCP batch arrival wakes a pending submission probe without requiring rebind", async () => {
  const fixture = surface(() => new Promise(() => {}));
  const progress = new ChatGptExternalTurnProgress();
  const result = accepted(worker(), fixture, undefined, progress);
  const timer = setTimeout(() => progress.recordToolBatch(1), 10);
  try { expect(await bounded(result, 500)).toBe("mcp_tool_call"); }
  finally { clearTimeout(timer); }
});

test("production send and multipart observation wire same-page recovery only for tool turns", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(source.includes("const toolTurnObservationRecovery = turn.externalProgress")).toBeTrue();
  expect(source.includes("callerSignal")).toBeTrue();
  expect((source.match(/toolTurnObservationRecovery,/g) ?? []).length).toBe(3);
  expect(source.includes("responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)")).toBeTrue();
});

test.each(["final", "multipart"] as const)("production %s send reacquires locators after recovery without resending", async lane => {
  let reads = 0;
  const first = surface(async () => {
    // Multipart captures its baseline in production before activating Send.
    if (lane === "multipart" && ++reads === 1) return initial;
    return timeout();
  });
  const next = surface(async () => ({ count: 1, lastId: "conversation-turn-new" }));
  const events: string[] = [];
  const instance = Object.assign(worker(), {
    activeComposer: async () => ({ locator: () => ({ getByTestId: () => ({
      waitFor: async () => {}, isEnabled: async () => true, press: async () => { events.push("send"); },
    }) }) }),
    attachPrompt: async () => { events.push("attach"); },
    waitForMultipartAcknowledgement: async (page: Page, turn: Locator) => {
      expect(page).toBe(next.page);
      expect(turn).toBe(next.assistant);
      events.push("ack");
    },
  });
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = lane === "final"
    ? source.indexOf('        await this.runStage(\n          turn.traceId,\n          "send",')
    : source.indexOf("        for (let index = 0; index < multipartTransport.stages.length;");
  const end = lane === "final"
    ? source.indexOf('        await diagnostics.capture(page, "send-accepted");', start)
    : source.indexOf("        if (mode.effort !== requestedMode.effort)", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const progress = new ChatGptExternalTurnProgress();
  const dependencies = {
    first, next, initial, events,
    turn: {
      traceId: `production-${lane}-rebind`, externalProgress: progress,
      onSendActivated: () => { events.push("activated"); },
      onSubmitted: () => { events.push("submitted"); },
    },
    prepared: { multipart: lane === "multipart" ? { parts: ["part"] } : undefined },
    multipartTransport: { stages: [{ text: "stage" }] },
    deadline: undefined,
    diagnostics: { capture: async () => {} },
    settleChatGptUi: async () => {},
    CHATGPT_SEND_ENABLE_GRACE_MS: 5_000,
    CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR,
    CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS, browserStageTimeouts, chatGptSuspensionClock,
    throwIfChatGptSessionFailureAlert, throwIfChatGptRateLimitDialog,
    activateChatGptSendControl, readChatGptAssistantTurnState,
  };
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    async function run() {
      let page = first.page;
      let responseTurns = first.responses;
      let responseTurn = first.assistant;
      const userTurns = first.baseline.userTurns;
      const initialResponseTurn = initial;
      const initialUserTurnCount = 1;
      let retrySubmitted = () => events.push("retry-submitted");
      const toolTurnObservationRecovery = async () => {
        events.push("rebind");
        page = next.page;
        return page;
      };
      ${source.slice(start, end)}
      return { responseTurns, responseTurn };
    }
  `);
  const run = new Function(...Object.keys(dependencies), `${compiled}; return run;`)(...Object.values(dependencies));
  const result = await run.call(instance);
  if (lane === "final") {
    expect(result.responseTurns).toBe(next.responses);
    expect(result.responseTurn).toBe(next.assistant);
    expect(events).toEqual(["activated", "send", "rebind", "submitted", "retry-submitted"]);
  } else {
    expect(events).toEqual(["attach", "activated", "send", "rebind", "ack"]);
    expect(next.selected).toEqual(["conversation-turn-new"]);
  }
});
