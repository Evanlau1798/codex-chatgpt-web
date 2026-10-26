import { expect, test } from "bun:test";
import { ChatGptCompletionTracker, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";

const quiet = { responsePresent: true, running: false, currentText: "", completionActionVisible: false,
  projection: { rootId: "owned", boundaryProtocolPresent: false, lastNodePresent: true, lastMutationAt: 0, animations: [] } };

test("a final delayed until 125 seconds survives the upstream #885 timeline", () => {
  const health = new ChatGptTurnDomHealthTracker();
  const completion = new ChatGptCompletionTracker();
  for (const now of [0, 60_000, 124_999]) {
    expect(health.update(quiet, now)).toBeUndefined();
    expect(completion.update(quiet, now).status).toBe("waiting");
  }
  const final = { ...quiet, currentText: "The requested work is complete.", completionActionVisible: true };
  expect(health.update(final, 125_000)).toBeUndefined();
  expect(completion.update(final, 125_000).status).toBe("waiting");
  expect(completion.update(final, 127_000).status).toBe("complete");
});

test("quiet waiting remains bounded at ten minutes", () => {
  const health = new ChatGptTurnDomHealthTracker();
  expect(health.update(quiet, 0)).toBeUndefined();
  expect(health.update(quiet, 599_999)).toBeUndefined();
  expect(health.update(quiet, 600_000)).toContain("without a final answer");
  expect(health.failureKind()).toBe("completion_evidence");
});

test("a proven empty completion or vanished DOM keeps its existing shorter deadline", () => {
  const empty = new ChatGptTurnDomHealthTracker();
  expect(empty.update({ ...quiet, completionActionVisible: true }, 0)).toBeUndefined();
  expect(empty.update({ ...quiet, completionActionVisible: true }, 10_000)).toContain("completed without a final answer");
  const vanished = new ChatGptTurnDomHealthTracker();
  expect(vanished.update({ ...quiet, responsePresent: false }, 0)).toBeUndefined();
  expect(vanished.update({ ...quiet, responsePresent: false }, 60_000)).toContain("did not create a response DOM");
});
