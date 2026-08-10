import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { encodeCompactionSummary } from "../src/responses/compaction";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  rememberResponseState,
} from "../src/responses/state";

const testHome = join(process.cwd(), "tmp", `response-state-compaction-${process.pid}`);

const oldUser = { type: "message", role: "user", content: "old user context" };
const oldAssistant = { type: "message", role: "assistant", content: "old assistant context" };
const compacted = {
  type: "compaction",
  encrypted_content: encodeCompactionSummary("Continue from the compacted checkpoint."),
};
const latestUser = { type: "message", role: "user", content: "continue after compact" };

beforeEach(() => {
  process.env.CODEX_CHATGPT_WEB_HOME = testHome;
  clearResponseStateForTests();
});

afterEach(() => {
  clearResponseStateForTests();
  delete process.env.CODEX_CHATGPT_WEB_HOME;
});

function rememberOldTurn(): void {
  rememberResponseState(
    { input: [oldUser] },
    { id: "resp_before_compact", status: "completed", output: [oldAssistant] },
    { force: true },
  );
}

test("a new compaction boundary replaces previous_response_id history", () => {
  rememberOldTurn();
  const raw = {
    previous_response_id: "resp_before_compact",
    input: [compacted, latestUser],
  };

  const expanded = expandPreviousResponseInput(raw) as { input: unknown[] };

  expect(expanded).not.toBe(raw);
  expect(expanded.input).toEqual([compacted, latestUser]);
});

test("post-compaction response state never resurrects the replaced history", () => {
  rememberOldTurn();
  const compactedTurn = expandPreviousResponseInput({
    previous_response_id: "resp_before_compact",
    input: [compacted, latestUser],
  }) as Record<string, unknown>;
  const postCompactAssistant = { type: "message", role: "assistant", content: "post compact answer" };
  rememberResponseState(
    compactedTurn,
    { id: "resp_after_compact", status: "completed", output: [postCompactAssistant] },
    { force: true },
  );

  const next = expandPreviousResponseInput({
    previous_response_id: "resp_after_compact",
    input: [{ type: "message", role: "user", content: "next request" }],
  }) as { input: unknown[] };

  expect(next.input).toEqual([
    compacted,
    latestUser,
    postCompactAssistant,
    { type: "message", role: "user", content: "next request" },
  ]);
  expect(JSON.stringify(next.input)).not.toContain("old user context");
  expect(JSON.stringify(next.input)).not.toContain("old assistant context");
});

test("a self-contained compaction replacement survives a missing continuation cache", () => {
  const raw = {
    previous_response_id: "resp_missing_after_restart",
    input: [compacted, latestUser],
  };

  const expanded = expandPreviousResponseInput(raw) as { input: unknown[] };

  expect(expanded).not.toBe(raw);
  expect(expanded.input).toEqual([compacted, latestUser]);
});

test("ordinary continuation still expands cached history and fails open only when state exists", () => {
  rememberOldTurn();
  const expanded = expandPreviousResponseInput({
    previous_response_id: "resp_before_compact",
    input: "ordinary continuation",
  }) as { input: unknown[] };
  expect(expanded.input).toEqual([
    oldUser,
    oldAssistant,
    { role: "user", content: "ordinary continuation" },
  ]);

  const missing = { previous_response_id: "resp_missing", input: "partial continuation" };
  expect(expandPreviousResponseInput(missing)).toBe(missing);
});
