import { expect, test } from "bun:test";
import {
  ChatGptBrowserWorker,
  ChatGptPromptAttachmentIntegrityError,
} from "../src/adapters/chatgpt-web/browser-worker";

type BrowserWorkerInternals = {
  selectConnector(page: unknown): Promise<unknown>;
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

for (const pill of ["missing", "selected", "unrecoverable"] as const) test.each([
  ["prompt attachment", async (fixture: object, page: object) => {
    await workerMethods.attachPrompt.call(fixture, page, "new suffix", true);
  }],
  ["compaction retry wrapper", async (fixture: object, page: object) => {
    await workerMethods.attachPromptWithCompactionRetry.call(
      fixture,
      page,
      "compact suffix",
      true,
      true,
      { userTurns: {}, responseTurns: {}, initialTurnIdentities: [] },
    );
  }],
] as const)(`REG-03: %s verifies its current ${pill} pill when initial connector binding is required`, async (_name, run) => {
  const calls: string[] = [];
  let selected = pill === "selected";
  const selectionError = new Error("fixture connector unavailable");
  const composer = {
    fill: async () => { calls.push("fill"); },
    focus: async () => { calls.push("focus"); },
    pressSequentially: async () => { calls.push("mention"); },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      calls.push("select");
      selected = true;
    },
  };
  const row = {
    waitFor: async () => { if (pill === "unrecoverable") throw selectionError; },
    count: async () => 1,
    getAttribute: async () => "",
  };
  const absentDialog = {
    filter: () => absentDialog,
    last: () => ({ isVisible: async () => false }),
  };
  const page = {
    getByText: () => ({}),
    locator: (selector: string) => selector === '[role="dialog"]' ? absentDialog : { filter: () => row },
    keyboard: { press: async () => { calls.push("document-end"); } },
  };
  const fixture = {
    config: { appName: "Codex Native2" },
    attachPrompt: workerMethods.attachPrompt,
    activeComposer: async () => composer,
    selectConnector: workerMethods.selectConnector,
    ensureConnectorSurface: async () => {},
    clearChatGptComposerState: async () => { calls.push("cleanup"); },
    connectorIsSelected: async () => {
      calls.push(selected ? "verified" : "missing");
      return selected;
    },
    selectedConnectorControl: () => ({ waitFor: async () => {} }),
    insertPromptText: async () => { calls.push("insert-prompt"); },
    assertPromptAttached: async () => { calls.push("assert-prompt"); },
  };

  if (pill === "unrecoverable") {
    await expect(run(fixture, page)).rejects.toBe(selectionError);
    expect(calls).toContain("cleanup");
    expect(calls).not.toContain("insert-prompt");
    expect(calls).not.toContain("assert-prompt");
    return;
  }
  await run(fixture, page);
  expect(calls.filter(call => call === "select")).toHaveLength(pill === "selected" ? 0 : 1);
  expect(calls.filter(call => call === "insert-prompt")).toHaveLength(1);
  expect(calls).toContain("verified");
  expect(calls.indexOf("verified")).toBeLessThan(calls.indexOf("insert-prompt"));
  expect(calls.at(-1)).toBe("assert-prompt");
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
