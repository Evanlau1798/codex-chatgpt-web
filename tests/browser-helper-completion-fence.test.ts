import { expect, test } from "bun:test";
import { BrowserHelperFenceRegistry } from "../src/adapters/chatgpt-web/browser-helper-fence";
import { assertLauncherHelperFenceFeatures } from "../src/adapters/chatgpt-web/launcher-helper-fence";
import { parseLauncherHelperMessage } from "../src/adapters/chatgpt-web/launcher-helper-protocol";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const fencedTurn = { externalProgress: {} } as BrowserTurn;

test("legacy helpers remain usable only for turns without external MCP progress", () => {
  expect(() => assertLauncherHelperFenceFeatures({} as BrowserTurn, new Set())).not.toThrow();
  expect(() => assertLauncherHelperFenceFeatures(fencedTurn, new Set(["progress"])))
    .toThrow("tool-boundary acknowledgement");
  expect(() => assertLauncherHelperFenceFeatures(fencedTurn, new Set(["progress", "tool-boundary-ack"])))
    .toThrow("completion fence");
});

test("helper protocol validates tool boundaries and completion requests", () => {
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "tool_batch_observed", revision: 2,
  }))).toEqual({ type: "event", id: "trace_123", event: "tool_batch_observed", revision: 2 });
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "completion_fence_commit", requestId: 1, revision: -1,
  }))).toThrow("revision is invalid");
});

test("helper fence registry correlates begin and commit acknowledgements", async () => {
  const sent: unknown[] = [];
  const registry = new BrowserHelperFenceRegistry(message => {
    sent.push(message);
    return true;
  }, () => {});
  const transport = registry.start("trace_123", true);
  const begin = transport.completionFence!.begin();
  const beginFrame = sent[0] as { requestId: number };
  registry.resolveBegin("trace_123", beginFrame.requestId, 4);
  expect(await begin).toBe(4);

  const commit = transport.completionFence!.commit(4);
  const commitFrame = sent[1] as { requestId: number };
  registry.resolveCommit("trace_123", commitFrame.requestId, true);
  expect(await commit).toBeTrue();
  registry.end("trace_123");
});

test("ending a helper turn rejects an outstanding completion fence", async () => {
  const registry = new BrowserHelperFenceRegistry(() => true, () => {});
  const pending = registry.start("trace_123", true).completionFence!.begin();
  registry.end("trace_123");
  let failure: unknown;
  try { await pending; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DOMException);
});
