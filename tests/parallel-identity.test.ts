import { expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import { ChatGptAgentSessionGraph } from "../src/adapters/chatgpt-web/agent-session-graph";
import { parallelAdmissionIdentity } from "../src/adapters/chatgpt-web/parallel-identity";

test("native ancestry rejects a nested worker even with no occupied slots", () => {
  const graph = new ChatGptAgentSessionGraph();
  graph.link("ns:root", "ns:left"); graph.link("ns:left", "ns:nested");
  const sessions = { groupAncestry: graph.ancestryOf.bind(graph) };
  const parsed = (threadId: string, parent?: string, name?: string) => ({
    _rawBody: { client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: threadId, parent_thread_id: parent, agent_name: name,
    }) } },
  }) as CodexParsedRequest;
  const root = parallelAdmissionIdentity(parsed("root"), "ns", sessions);
  const worker = parallelAdmissionIdentity(parsed("left", "root", "/root/left"), "ns", sessions);
  expect(worker).toEqual({ group: root.group, role: "worker" });
  expect(() => parallelAdmissionIdentity(parsed("nested", "left"), "ns", sessions)).toThrow("Nested native workers");
  // Native task path closes the gap when the parent graph has not arrived yet.
  expect(() => parallelAdmissionIdentity(parsed("unseen", "left", "/root/left/nested"), "ns", sessions)).toThrow("Nested native workers");
  const misleading = parsed("root");
  Object.assign(misleading._rawBody!, { input: [{ role: "user", content: "/root/left/nested" }] });
  expect(parallelAdmissionIdentity(misleading, "ns", sessions)).toEqual(root);
});
