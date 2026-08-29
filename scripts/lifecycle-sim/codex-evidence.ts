export type CodexLifecycleRole = "root" | "child" | "grandchild";

export type CodexLifecycleRequestEvidence = {
  role: CodexLifecycleRole;
  step: number;
  threadId?: string;
  agentName?: string;
  inputTypes: string[];
  functionOutputs: string[];
};

const v2AgentNames: Record<CodexLifecycleRole, string> = {
  root: "/root",
  child: "/root/lifecycle_child",
  grandchild: "/root/lifecycle_child/lifecycle_grandchild",
};

export function assertCodexLifecycleRequests(
  requests: CodexLifecycleRequestEvidence[],
  protocol: "v1" | "v2",
): void {
  const threads = new Map<CodexLifecycleRole, string>();
  for (const request of requests) {
    if (!request.threadId) throw new Error(`${request.role}:${request.step} has no thread ownership evidence`);
    const owned = threads.get(request.role);
    if (owned && owned !== request.threadId) {
      throw new Error(`${request.role} changed thread ownership from ${owned} to ${request.threadId}`);
    }
    threads.set(request.role, request.threadId);
    if (protocol === "v2" && request.agentName !== v2AgentNames[request.role]) {
      throw new Error(`${request.role}:${request.step} used unexpected agent scope ${request.agentName ?? "none"}`);
    }
    const needsToolResult = (request.role === "root" && request.step >= 1 && request.step <= 4)
      || (request.role === "child" && request.step >= 1 && request.step <= 2);
    if (needsToolResult && request.functionOutputs.length === 0) {
      throw new Error(`${request.role}:${request.step} has no preceding tool result`);
    }
    for (let index = 0; index < request.inputTypes.length; index += 1) {
      if (request.inputTypes[index] === "function_call_output"
        && !request.inputTypes.slice(0, index).includes("function_call")) {
        throw new Error(`${request.role}:${request.step} has reversed function-call ordering`);
      }
    }
  }
  const owners = [...threads.values()];
  if (new Set(owners).size !== owners.length) throw new Error("nested roles reused a thread owner");
}
