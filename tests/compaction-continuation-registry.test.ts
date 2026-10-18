import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberCompactionContinuation, isAcceptedCompactionContinuation, recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
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

test("an aborted primary instruction revokes its checkpoint and every retained representation", () => {
  const f = fixture();
  const retained = { turnId: "older", content: "Earlier human task" };
  rememberCompactionContinuation(f.parsed, f.identity, [f.source, retained], "Checkpoint A");
  for (const owner of ["unrelated", f.identity.turnId, f.source.turnId]) {
    const parsed = { ...f.parsed, _rawBody: { input: [...(f.parsed._rawBody as { input: unknown[] }).input, {
      type: "message", role: "user", id: "abort-notice", content: "<turn_aborted>The user interrupted this turn.</turn_aborted>",
      internal_chat_message_metadata_passthrough: { turn_id: owner },
    }] } };
    const valid = owner !== f.source.turnId;
    expect(isAcceptedCompactionContinuation(parsed, f.identity, f.source)).toBe(valid);
    expect(isAcceptedCompactionContinuation(parsed, f.identity, retained)).toBe(valid);
    expect(recoverCompactionInstruction(parsed, f.identity) !== undefined).toBe(valid);
  }
  const untagged = { content: "Source without an authenticated turn owner" };
  rememberCompactionContinuation(f.parsed, f.identity, [untagged], "Checkpoint A");
  const unknownOwner = { ...f.parsed, _rawBody: { input: [...(f.parsed._rawBody as { input: unknown[] }).input, {
    type: "message", role: "user", content: "<turn_aborted>Interrupted.</turn_aborted>",
    internal_chat_message_metadata_passthrough: { turn_id: "previous" },
  }] } };
  expect(isAcceptedCompactionContinuation(unknownOwner, f.identity, untagged)).toBeFalse();
});

test("a fresh daemon cannot invent checkpoint authorization from replay text", async () => {
  const f = fixture(); f.remember();
  const module = new URL("../src/adapters/chatgpt-web/compaction-continuation.ts", import.meta.url).href;
  const script = `import { isAcceptedCompactionContinuation as accepts } from ${JSON.stringify(module)};
    process.exit(accepts(${JSON.stringify(f.parsed)}, ${JSON.stringify(f.identity)}, ${JSON.stringify(f.source)}) ? 1 : 0);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
});

test("an exact daemon checkpoint survives process restart without granting mismatched authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "compaction-proof-"));
  const path = join(root, "checkpoints.json");
  const f = fixture();
  const retained = { turnId: "older", content: "Earlier human task" };
  const module = new URL("../src/adapters/chatgpt-web/compaction-continuation.ts", import.meta.url).href;
  const probe = async (write: boolean, parsed = f.parsed, identity = f.identity, source = f.source) => {
    const script = `import { loadCompactionContinuationState, rememberCompactionContinuation, isAcceptedCompactionContinuation } from ${JSON.stringify(module)};
      loadCompactionContinuationState(${JSON.stringify(path)});
      const parsed=${JSON.stringify(parsed)}, identity=${JSON.stringify(identity)}, source=${JSON.stringify(source)};
      if (${write}) rememberCompactionContinuation(parsed, identity, [source, ${JSON.stringify(retained)}], "Checkpoint A");
      console.log(isAcceptedCompactionContinuation(parsed, identity, source));`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
    return out.trim() === "true";
  };
  try {
    expect(await probe(false)).toBeFalse();
    expect(await probe(true)).toBeTrue();
    expect(await probe(false)).toBeTrue();
    const snapshot = readFileSync(path, "utf8");
    for (const secret of ["Checkpoint A", "Current task", f.identity.threadId, f.source.turnId, retained.content]) expect(snapshot).not.toContain(secret);
    const withAbort = (owner: string) => ({ ...f.parsed, _rawBody: { input: [...(f.parsed._rawBody as { input: unknown[] }).input, {
      type: "message", role: "user", id: "abort-notice", content: "<turn_aborted>The user interrupted this turn.</turn_aborted>",
      internal_chat_message_metadata_passthrough: { turn_id: owner },
    }] } });
    expect(await probe(false, withAbort("unrelated"))).toBeTrue();
    expect(await probe(false, withAbort(f.source.turnId))).toBeFalse();
    expect(await probe(false, withAbort(f.source.turnId), f.identity, retained)).toBeFalse();
    const legacy = JSON.parse(snapshot);
    for (const [, entry] of legacy.checkpoints) delete entry.sourceTurnHash;
    writeFileSync(path, JSON.stringify(legacy));
    expect(await probe(false)).toBeTrue();
    expect(await probe(false, withAbort("unrelated"))).toBeTrue();
    expect(await probe(false, withAbort(f.source.turnId))).toBeFalse();
    expect(await probe(false, withAbort(f.source.turnId), f.identity, retained)).toBeFalse();
    writeFileSync(path, snapshot);
    expect(await probe(false, { ...f.parsed, modelId: "other" })).toBeFalse();
    expect(await probe(false, { ...f.parsed, options: { reasoning: "high" } })).toBeFalse();
    expect(await probe(false, f.parsed, { ...f.identity, turnId: "other" })).toBeFalse();
    expect(await probe(false, f.parsed, f.identity, { ...f.source, content: "changed" })).toBeFalse();
    expect(await probe(false, { ...f.parsed, _rawBody: { input: [f.item("Checkpoint B")] } })).toBeFalse();
    const invalidOwner = JSON.parse(snapshot);
    invalidOwner.checkpoints[0][1].sourceTurnHash = 42;
    for (const invalid of ["{broken", '{"version":2,"checkpoints":[]}', snapshot.replace(/[a-f0-9]{64}/, "invalid"), JSON.stringify(invalidOwner)]) {
      writeFileSync(path, invalid);
      expect(await probe(false)).toBeFalse();
    }
    unlinkSync(path);
    expect(await probe(false)).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("a failed proof write cannot authorize an unacknowledged checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "compaction-proof-write-"));
  const f = fixture();
  const module = new URL("../src/adapters/chatgpt-web/compaction-continuation.ts", import.meta.url).href;
  const script = `import { loadCompactionContinuationState, rememberCompactionContinuation, isAcceptedCompactionContinuation } from ${JSON.stringify(module)};
    loadCompactionContinuationState(${JSON.stringify(root)});
    const parsed=${JSON.stringify(f.parsed)}, identity=${JSON.stringify(f.identity)}, source=${JSON.stringify(f.source)};
    let failed=false;
    try { rememberCompactionContinuation(parsed, identity, [source], "Checkpoint A"); } catch { failed=true; }
    console.log(JSON.stringify({failed,accepted:isAcceptedCompactionContinuation(parsed,identity,source)}));`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ failed: true, accepted: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
