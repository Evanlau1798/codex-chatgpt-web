import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rememberCompactionContinuation, isAcceptedCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { encodeCompactionSummary } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

function fixture() {
  const identity = { threadId: randomUUID(), turnId: "current" };
  const source = { turnId: "previous", content: "Current task" };
  const item = (text: string) => ({ type: "compaction", encrypted_content: encodeCompactionSummary(text) });
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: false,
    options: { reasoning: "medium" }, context: { messages: [] }, _compactionRequest: true,
    _rawBody: { input: [item("Checkpoint A")] } };
  const remember = (text = "Checkpoint A") => rememberCompactionContinuation(parsed, identity, [source], text);
  const accepts = () => isAcceptedCompactionContinuation(parsed, identity, source);
  return { identity, source, parsed, item, remember, accepts };
}

test("new checkpoints replace old evidence and never fall back past a newer invalid checkpoint", () => {
  const f = fixture();
  f.remember();
  expect(f.accepts()).toBeTrue();
  f.remember("Checkpoint B");
  expect(f.accepts()).toBeFalse();
  f.parsed._rawBody = { input: [f.item("Checkpoint B")] };
  expect(f.accepts()).toBeTrue();
  for (const newer of [f.item("Checkpoint A"), { type: "compaction", encrypted_content: "malformed" }]) {
    f.parsed._rawBody = { input: [f.item("Checkpoint B"), newer] };
    expect(f.accepts()).toBeFalse();
  }
});

test("continuation evidence is isolated by backend model, effort, owner and exact source", () => {
  const f = fixture(); f.remember();
  expect(isAcceptedCompactionContinuation({ ...f.parsed, modelId: "different-backend" }, f.identity, f.source)).toBeFalse();
  expect(isAcceptedCompactionContinuation({ ...f.parsed, options: { reasoning: "high" } }, f.identity, f.source)).toBeFalse();
  expect(isAcceptedCompactionContinuation(f.parsed, { ...f.identity, turnId: "other" }, f.source)).toBeFalse();
  expect(isAcceptedCompactionContinuation(f.parsed, f.identity, { ...f.source, content: "rewritten" })).toBeFalse();
});

test("the 256-entry limit evicts least recently used evidence but refreshes accepted continuations", () => {
  const entries = Array.from({ length: 256 }, fixture);
  for (const entry of entries) entry.remember();
  expect(entries[0]!.accepts()).toBeTrue();
  fixture().remember();
  expect(entries[0]!.accepts()).toBeTrue();
  expect(entries[1]!.accepts()).toBeFalse();
});

test("a fresh daemon cannot invent checkpoint authorization from replay text", async () => {
  const f = fixture(); f.remember();
  const module = new URL("../src/adapters/chatgpt-web/compaction-continuation.ts", import.meta.url).href;
  const script = `import { isAcceptedCompactionContinuation as accepts } from ${JSON.stringify(module)};
    process.exit(accepts(${JSON.stringify(f.parsed)}, ${JSON.stringify(f.identity)}, ${JSON.stringify(f.source)}) ? 1 : 0);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
});
