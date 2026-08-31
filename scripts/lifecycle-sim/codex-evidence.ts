import { createHash } from "node:crypto";

export type CodexLifecycleRole = "root" | "child" | "grandchild";

export type CodexLifecycleRequestEvidence = {
  role: CodexLifecycleRole;
  step: number;
  threadId?: string;
  agentName?: string;
  inputTypes: string[];
  functionCalls: Array<{ callId: string; name: string; argumentsDigest: string; index: number }>;
  functionOutputs: Array<{ callId: string; outputDigest: string; index: number }>;
};

type HistoryEvent =
  | { kind: "call"; callId: string; name: string; digest: string }
  | { kind: "output"; callId: string; digest: string };

export const digestLifecyclePayload = (value: string): string => (
  createHash("sha256").update(value).digest("hex")
);

function orderedHistory(request: CodexLifecycleRequestEvidence): HistoryEvent[] {
  return [
    ...request.functionCalls.map(call => ({
      kind: "call" as const,
      callId: call.callId,
      name: call.name,
      digest: call.argumentsDigest,
      index: call.index,
    })),
    ...request.functionOutputs.map(output => ({
      kind: "output" as const,
      callId: output.callId,
      digest: output.outputDigest,
      index: output.index,
    })),
  ].toSorted((left, right) => left.index - right.index)
    .map(({ index: _index, ...event }) => event);
}

function assertAppendOnly(previous: HistoryEvent[], current: HistoryEvent[], role: CodexLifecycleRole): void {
  if (previous.some((event, index) => JSON.stringify(event) !== JSON.stringify(current[index]))) {
    throw new Error(`${role} violated append-only history`);
  }
}

const v2AgentNames: Record<CodexLifecycleRole, string> = {
  root: "/root",
  child: "/root/lifecycle_child",
  grandchild: "/root/lifecycle_child/lifecycle_grandchild",
};

const expectedSteps: Record<CodexLifecycleRole, number[]> = {
  root: [0, 1, 2, 3, 4],
  child: [0, 1, 2, 3],
  grandchild: [0],
};

const expectedTools = (protocol: "v1" | "v2"): Record<CodexLifecycleRole, string[]> => ({
  root: ["spawn_agent", "wait_agent", protocol === "v1" ? "send_input" : "followup_task", "wait_agent"],
  child: ["spawn_agent", "wait_agent"],
  grandchild: [],
});

export function assertCodexLifecycleRequests(
  requests: CodexLifecycleRequestEvidence[],
  protocol: "v1" | "v2",
): void {
  const threads = new Map<CodexLifecycleRole, string>();
  const histories = new Map<CodexLifecycleRole, HistoryEvent[]>();
  for (const request of requests) {
    if (!expectedSteps[request.role].includes(request.step)) {
      throw new Error(`${request.role} did not follow exact lifecycle steps: unexpected ${request.step}`);
    }
    if (!request.threadId) throw new Error(`${request.role}:${request.step} has no thread ownership evidence`);
    const owned = threads.get(request.role);
    if (owned && owned !== request.threadId) {
      throw new Error(`${request.role} changed thread ownership from ${owned} to ${request.threadId}`);
    }
    threads.set(request.role, request.threadId);
    if (protocol === "v2" && request.agentName !== v2AgentNames[request.role]) {
      throw new Error(`${request.role}:${request.step} used unexpected agent scope ${request.agentName ?? "none"}`);
    }
    const calls = new Map(request.functionCalls.map(call => [call.callId, call]));
    if (calls.size !== request.functionCalls.length) {
      throw new Error(`${request.role}:${request.step} has duplicate function call IDs`);
    }
    const resultIds = new Set<string>();
    for (const call of request.functionCalls) {
      if (!/^[a-f0-9]{64}$/.test(call.argumentsDigest)) {
        throw new Error(`${request.role}:${request.step} has invalid function-call arguments digest`);
      }
    }
    for (const result of request.functionOutputs) {
      if (resultIds.has(result.callId)) {
        throw new Error(`${request.role}:${request.step} has duplicate results for call ID ${result.callId}`);
      }
      resultIds.add(result.callId);
      const call = calls.get(result.callId);
      if (!call) throw new Error(`${request.role}:${request.step} has an unknown result call ID ${result.callId}`);
      if (call.index >= result.index) {
        throw new Error(`${request.role}:${request.step} has reversed function-call ordering for ${result.callId}`);
      }
      if (!/^[a-f0-9]{64}$/.test(result.outputDigest)) {
        throw new Error(`${request.role}:${request.step} has invalid function output digest`);
      }
    }
    if (request.functionCalls.length !== request.functionOutputs.length) {
      throw new Error(`${request.role}:${request.step} does not have exact tool results`);
    }
    const expectedCallCount = request.role === "root"
      ? request.step
      : request.role === "child" ? Math.min(request.step, 2) : 0;
    if (request.functionCalls.length !== expectedCallCount) {
      throw new Error(`${request.role}:${request.step} does not have exact tool history`);
    }
    const names = request.functionCalls.toSorted((left, right) => left.index - right.index).map(call => call.name);
    const expectedNames = expectedTools(protocol)[request.role].slice(0, names.length);
    if (names.length > expectedTools(protocol)[request.role].length
      || names.some((name, index) => name !== expectedNames[index])) {
      throw new Error(`${request.role}:${request.step} used unexpected tool history: ${JSON.stringify(names)}`);
    }
    const history = orderedHistory(request);
    assertAppendOnly(histories.get(request.role) ?? [], history, request.role);
    histories.set(request.role, history);
  }
  const owners = [...threads.values()];
  if (new Set(owners).size !== owners.length) throw new Error("nested roles reused a thread owner");
  for (const role of Object.keys(expectedSteps) as CodexLifecycleRole[]) {
    const actual = requests.filter(request => request.role === role).map(request => request.step);
    if (actual.length !== expectedSteps[role].length
      || actual.some((step, index) => step !== expectedSteps[role][index])) {
      throw new Error(`${role} did not follow exact lifecycle steps: ${JSON.stringify(actual)}`);
    }
  }
}
