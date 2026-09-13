import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("an exact daemon checkpoint survives process restart without granting mismatched authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "compaction-proof-"));
  const path = join(root, "checkpoints.json");
  const f = fixture();
  const module = new URL("../src/adapters/chatgpt-web/compaction-continuation.ts", import.meta.url).href;
  const probe = async (write: boolean, parsed = f.parsed, identity = f.identity, source = f.source) => {
    const script = `import { loadCompactionContinuationState, rememberCompactionContinuation, isAcceptedCompactionContinuation } from ${JSON.stringify(module)};
      loadCompactionContinuationState(${JSON.stringify(path)});
      const parsed=${JSON.stringify(parsed)}, identity=${JSON.stringify(identity)}, source=${JSON.stringify(source)};
      if (${write}) rememberCompactionContinuation(parsed, identity, [source], "Checkpoint A");
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
    for (const secret of ["Checkpoint A", "Current task", f.identity.threadId]) expect(snapshot).not.toContain(secret);
    expect(await probe(false, { ...f.parsed, modelId: "other" })).toBeFalse();
    expect(await probe(false, { ...f.parsed, options: { reasoning: "high" } })).toBeFalse();
    expect(await probe(false, f.parsed, { ...f.identity, turnId: "other" })).toBeFalse();
    expect(await probe(false, f.parsed, f.identity, { ...f.source, content: "changed" })).toBeFalse();
    expect(await probe(false, { ...f.parsed, _rawBody: { input: [f.item("Checkpoint B")] } })).toBeFalse();
    for (const invalid of ["{broken", '{"version":2,"checkpoints":[]}', snapshot.replace(/[a-f0-9]{64}/, "invalid")]) {
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
