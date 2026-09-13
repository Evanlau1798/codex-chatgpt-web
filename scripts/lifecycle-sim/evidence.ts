export function assertLifecycleEvidence(observed: string[], required: string[]): void {
  for (let index = 0; index < Math.max(observed.length, required.length); index += 1) {
    if (observed[index] === required[index]) continue;
    const expected = required[index];
    const actual = observed[index];
    if (expected !== undefined && !observed.includes(expected)) {
      throw new Error(`missing lifecycle phase: ${expected} at ${index}; observed=${JSON.stringify(observed)}`);
    }
    if (expected !== undefined && observed.indexOf(expected, index + 1) >= 0) {
      throw new Error(`lifecycle phase is out of order at ${index}: ${expected}; observed=${JSON.stringify(observed)}`);
    }
    throw new Error(`unexpected lifecycle phase at ${index}: ${actual ?? "end"}; observed=${JSON.stringify(observed)}`);
  }
}

export function assertSingleLifecycleEvidence(observed: string[], phase: string): void {
  if (observed.filter(value => value === phase).length !== 1) {
    throw new Error(`expected exactly one lifecycle phase: ${phase}`);
  }
}

export function assertClaudeLifecycleEvidence(observed: string[]): void {
  assertSingleLifecycleEvidence(observed, "subagent_launch_ack");
  const ack = observed.indexOf("subagent_launch_ack");
  if (ack <= observed.indexOf("tool_result") || ack >= observed.indexOf("subagent_result")) {
    throw new Error("Claude launch acknowledgement must follow the Agent call and precede its completed result");
  }
  // The async launch acknowledgement and the child request race; neither is a completed result.
  assertLifecycleEvidence(observed.filter(phase => phase !== "subagent_launch_ack"), [
    "request", "tool_call", "tool_result", "subagent_request", "subagent_result",
    "subagent_notification", "compact", "interrupt", "resume", "steering_active", "steering", "idle",
  ]);
}

export function assertClaudeSubagentNotification(text: string, agentId: string | undefined): void {
  const boundaries = text.match(/<\/?task-notification\b[^>]*>/g);
  const block = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)?.[1];
  if (!agentId || !block || boundaries?.length !== 2
    || boundaries[0] !== "<task-notification>" || boundaries[1] !== "</task-notification>") {
    throw new Error("Claude child notification did not deliver the exact completed agent result");
  }
  for (const [field, expected] of [["task-id", agentId], ["tool-use-id", "toolu_lifecycle_agent"],
    ["status", "completed"], ["result", "CLAUDE_LIFECYCLE_CHILD_DONE"]]) {
    const tags = text.match(new RegExp(`<\\/?${field}\\b[^>]*>`, "g"));
    const values = [...block.matchAll(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, "g"))];
    if (tags?.length !== 2 || tags[0] !== `<${field}>` || tags[1] !== `</${field}>`
      || values.length !== 1 || values[0]![1] !== expected) {
      throw new Error(`Claude child notification has an invalid or duplicate ${field}`);
    }
  }
}
