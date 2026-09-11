import { expect, test } from "bun:test";
import {
  ChatGptBrowserWorker,
  ChatGptPromptAttachmentIntegrityError,
} from "../src/adapters/chatgpt-web/browser-worker";

type BrowserWorkerInternals = {
  attachPrompt(
    page: unknown,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: unknown,
  ): Promise<void>;
  attachPromptWithCompactionRetry(
    page: unknown,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: unknown,
    captureDiagnostic?: unknown,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable?: boolean,
    connectorAttemptBudget?: { triggerAttempts: number },
  ): Promise<void>;
};

const workerMethods = ChatGptBrowserWorker.prototype as unknown as BrowserWorkerInternals;

test.each([
  ["retained response", async (fixture: object, page: object) => {
    await workerMethods.attachPrompt.call(fixture, page, "new suffix", true);
  }],
  ["retained compaction", async (fixture: object, page: object) => {
    await workerMethods.attachPromptWithCompactionRetry.call(
      fixture,
      page,
      "compact suffix",
      true,
      true,
      { userTurns: {}, responseTurns: {}, initialTurnIdentities: [] },
    );
  }],
] as const)("%s verifies the current connector pill before attaching its prompt", async (_name, run) => {
  const calls: string[] = [];
  const composer = {
    fill: async () => { calls.push("fill"); },
    focus: async () => { calls.push("focus"); },
  };
  const page = { keyboard: { press: async () => { calls.push("document-end"); } } };
  const fixture = {
    attachPrompt: workerMethods.attachPrompt,
    activeComposer: async () => composer,
    selectConnector: async () => {
      calls.push("select-connector");
      return composer;
    },
    insertPromptText: async () => { calls.push("insert-prompt"); },
    assertPromptAttached: async () => { calls.push("assert-prompt"); },
  };

  await run(fixture, page);

  expect(calls.filter(call => call === "select-connector")).toHaveLength(1);
  expect(calls.indexOf("select-connector")).toBeLessThan(calls.indexOf("insert-prompt"));
});

test("compaction attachment retry gets a fresh connector attempt budget", async () => {
  const connectorAttemptBudget = { triggerAttempts: 0 };
  let attempts = 0;
  const fixture = {
    attachPrompt: async (...args: unknown[]) => {
      const budget = args[6] as { triggerAttempts: number };
      attempts += 1;
      if (attempts === 1) {
        budget.triggerAttempts = 3;
        throw new ChatGptPromptAttachmentIntegrityError("fixture attachment drift");
      }
      expect(budget.triggerAttempts).toBe(0);
    },
    currentSubmissionEvidence: async () => undefined,
    resetCompactionComposerForRetry: async () => {},
  };

  await workerMethods.attachPromptWithCompactionRetry.call(
    fixture,
    {},
    "compact suffix",
    true,
    true,
    { userTurns: {}, responseTurns: {}, initialTurnIdentities: [] },
    undefined,
    undefined,
    false,
    connectorAttemptBudget,
  );

  expect(attempts).toBe(2);
});
