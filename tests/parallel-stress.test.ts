import { expect, test } from "bun:test";
import { ChatGptParallelAdmission } from "../src/adapters/chatgpt-web/parallel-admission";
import { bindClaudeSessionAbort } from "../src/adapters/chatgpt-web/claude-subagent";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptTurnSteeringId } from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";

test("cancelling one Claude child preserves parent, sibling and foreign namespace", () => {
  const sessions = new ChatGptTurnSessions();
  const cancelled: string[] = [];
  const thread = "claude_stress-session";
  for (const [key, namespace, turn] of [
    ["root", "owned", "claude_root"], ["left", "owned", "claude_left"],
    ["right", "owned", "claude_right"], ["foreign", "foreign", "claude_left"],
  ]) sessions.getOrCreate(key!, () => ({ mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => { cancelled.push(key!); },
  }), `${namespace}:${thread}`, chatGptTurnSteeringId(thread, turn!));
  const parsed = { _rawBody: { client_metadata: { claude_subagent: true,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "claude_left" }),
  } } } as CodexParsedRequest;
  const abort = new AbortController();
  bindClaudeSessionAbort(parsed, abort.signal, sessions, "owned");
  abort.abort();
  expect(cancelled).toEqual(["left"]);
  sessions.retireGroup(`owned:${thread}`);
  expect(cancelled.sort()).toEqual(["left", "right", "root"]);
  sessions.clear();
});

test.each([true, false])("child cancellation never widens when its agent identity is missing (already aborted=%s)", alreadyAborted => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  sessions.getOrCreate("root", () => ({ mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: () => { cancelled++; },
  }), "owned:claude_session");
  const parsed = { _rawBody: { client_metadata: { claude_subagent: true,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "claude_session" }),
  } } } as CodexParsedRequest;
  const abort = new AbortController();
  if (alreadyAborted) abort.abort();
  const unbind = bindClaudeSessionAbort(parsed, abort.signal, sessions, "owned");
  if (!alreadyAborted) abort.abort();
  unbind();
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("64 queued owners: overflow is refused, cancellation frees one slot, every survivor completes", async () => {
  const admission = new ChatGptParallelAdmission();
  const release = await admission.acquire({ group: "held", role: "root" });
  const controllers = Array.from({ length: 64 }, () => new AbortController());
  const outcomes = controllers.map((controller, i) => admission.run(
    { group: `queued-${i}`, role: "root" }, controller.signal, async () => i,
  ).then(value => ({ value }), error => ({ error: error.name })));
  await expect(admission.acquire({ group: "overflow", role: "root" })).rejects.toThrow("queue is full");
  controllers[31]!.abort();
  const replacement = admission.run({ group: "replacement", role: "root" }, undefined, async () => 64);
  release();
  const results = await Promise.all(outcomes);
  expect(results[31]).toEqual({ error: "AbortError" });
  expect(results.filter(value => "value" in value)).toHaveLength(63);
  expect(await replacement).toBe(64);
  (await admission.acquire({ group: "after", role: "root" }))();
});

test("a full unrelated root queue cannot consume the active tree's reserved worker and maintenance slots", async () => {
  const admission = new ChatGptParallelAdmission();
  const root = await admission.acquire({ group: "active", role: "root" });
  const controllers = Array.from({ length: 64 }, () => new AbortController());
  const queued = controllers.map((controller, i) => admission.acquire(
    { group: `other-${i}`, role: "root" }, controller.signal,
  ).then(release => { release(); return "started"; }, () => "cancelled"));
  try {
    const left = await admission.acquire({ group: "active", role: "worker" });
    const right = await admission.acquire({ group: "active", role: "worker" });
    const maintenance = await admission.acquire({ group: "active", role: "maintenance" });
    left(); right(); maintenance();
  } finally {
    controllers.forEach(controller => controller.abort());
    root();
    expect((await Promise.all(queued)).every(result => result === "cancelled")).toBeTrue();
  }
});

test("200 task trees preserve both child slots and compaction while refusing excess workers", async () => {
  const admission = new ChatGptParallelAdmission();
  for (let i = 0; i < 200; i++) {
    const group = `tree-${i}`;
    const root = await admission.acquire({ group, role: "root" });
    const left = await admission.acquire({ group, role: "worker" });
    const right = await admission.acquire({ group, role: "worker" });
    const maintenance = await admission.acquire({ group, role: "maintenance" });
    await expect(admission.acquire({ group, role: "worker" })).rejects.toThrow("two active workers");
    const controller = new AbortController();
    const queued = admission.acquire({ group: `other-${i}`, role: "root" }, controller.signal)
      .then(() => "unexpected", error => error.name);
    controller.abort();
    expect(await queued).toBe("AbortError");
    // Repeated/out-of-order release must not underflow the counters.
    right(); right(); root(); root(); maintenance(); left(); left();
  }
  (await admission.acquire({ group: "final", role: "root" }))();
});

test("a failing task releases its lease, an already-aborted task never executes", async () => {
  const admission = new ChatGptParallelAdmission();
  let executions = 0;
  await expect(admission.run({ group: "failure", role: "root" }, undefined, async () => {
    executions++;
    throw new Error("intentional tool failure");
  })).rejects.toThrow("intentional tool failure");
  const controller = new AbortController(); controller.abort();
  await expect(admission.run({ group: "aborted", role: "root" }, controller.signal,
    async () => { executions++; })).rejects.toThrow("aborted");
  expect(executions).toBe(1);
  (await admission.acquire({ group: "survivor", role: "root" }))();
});
