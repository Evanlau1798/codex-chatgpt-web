import { expect, test } from "bun:test";
import { ChatGptParallelAdmission } from "../src/adapters/chatgpt-web/parallel-admission";
import { ChatGptAgentSessionGraph } from "../src/adapters/chatgpt-web/agent-session-graph";

test("queued unrelated roots cannot starve children or compaction of an active root", async () => {
  const admission = new ChatGptParallelAdmission();
  const root = await admission.acquire({ group: "A", role: "root" });
  let nextRootStarted = false;
  const next = admission.acquire({ group: "B", role: "root" }).then(release => { nextRootStarted = true; return release; });
  const child1 = await admission.acquire({ group: "A", role: "worker" });
  const child2 = await admission.acquire({ group: "A", role: "worker" });
  const compact = await admission.acquire({ group: "A", role: "maintenance" });
  expect(nextRootStarted).toBeFalse();
  await expect(admission.acquire({ group: "A", role: "worker" })).rejects.toThrow("two active workers");
  root();
  expect(nextRootStarted).toBeFalse();
  child1(); child2(); compact();
  (await next)();
  expect(nextRootStarted).toBeTrue();
});

test("queued cancellation removes only that request and release is idempotent", async () => {
  const admission = new ChatGptParallelAdmission();
  const root = await admission.acquire({ group: "A", role: "root" });
  const controller = new AbortController();
  const waiting = admission.acquire({ group: "B", role: "root" }, controller.signal);
  const outcome = waiting.then(() => "started", () => "cancelled");
  controller.abort();
  expect(await outcome).toBe("cancelled");
  const child = await admission.acquire({ group: "A", role: "worker" });
  root(); root(); child(); child();
  const next = await admission.acquire({ group: "C", role: "root" });
  next();
});

test("queued excess children fail before execution instead of deadlocking their parents", async () => {
  const admission = new ChatGptParallelAdmission();
  const root = await admission.acquire({ group: "A", role: "root" });
  const first = admission.acquire({ group: "B", role: "worker" });
  const second = admission.acquire({ group: "B", role: "worker" });
  const third = admission.acquire({ group: "B", role: "worker" }).then(() => "started", () => "refused");
  root();
  const release1 = await first, release2 = await second;
  expect(await third).toBe("refused");
  release1(); release2();
});

test("native agent graph resolves ancestry and handles cycles without unbounded traversal", () => {
  const graph = new ChatGptAgentSessionGraph();
  graph.link("root", "left"); graph.link("root", "right"); graph.link("left", "nested");
  expect(graph.rootOf("nested")).toBe("root");
  graph.link("nested", "root");
  expect(graph.descendants("root")).toEqual(["root", "left", "right", "nested"]);
  expect(() => graph.rootOf("nested")).toThrow("cycle");
});
