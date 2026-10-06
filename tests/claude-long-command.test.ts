import { expect, test } from "bun:test";
import { normalizeClaudeLongCommands } from "../src/adapters/chatgpt-web/claude-long-command";
import { normalizeClaudeToolRequests } from "../src/adapters/chatgpt-web/claude-subagent";

const parsed = (background = true, output = true): any => ({ context: { tools: [
  { name: "Bash", parameters: { properties: background ? { run_in_background: { type: "boolean" } } : {} } },
  ...(output ? [{ name: "TaskOutput", parameters: { properties: { timeout: { type: "number" } } } }] : []),
] } });

test("long Bash retains exact command and lifetime while native task owns completion", () => {
  const requests: any = [
    { wireName: "Bash", freeform: false, arguments: { command: "sleep 330; echo READY", timeout: 400000 } },
    { wireName: "TaskOutput", freeform: false, arguments: { task_id: "owned", block: true, timeout: 400000 } },
  ];
  normalizeClaudeLongCommands(parsed(), requests);
  expect(requests[0].arguments).toEqual({ command: "sleep 330; echo READY", timeout: 400000, run_in_background: true });
  expect(requests[1].arguments).toEqual({ task_id: "owned", block: true, timeout: 30000 });
});

test("unsupported catalogs and unrelated or short calls remain unchanged", () => {
  for (const catalog of [parsed(false), parsed(true, false)]) {
    const calls: any = [{ wireName: "Bash", arguments: { command: "sleep 330", timeout: 400000 } }];
    const before = structuredClone(calls);
    normalizeClaudeLongCommands(catalog, calls);
    expect(calls).toEqual(before);
  }
  const calls: any = [{ wireName: "Bash", arguments: { command: "echo READY", timeout: 30000 } },
    { wireName: "Other", arguments: { timeout: 400000 } }];
  const before = structuredClone(calls);
  normalizeClaudeLongCommands(parsed(), calls);
  expect(calls).toEqual(before);
});

test("TaskOutput response wait is bounded without requiring Bash in the advertised catalog", () => {
  const context: any = { context: { tools: [
    { name: "TaskOutput", parameters: { properties: { timeout: { type: "number" } } } },
  ] } };
  const calls: any = [{ wireName: "TaskOutput", arguments: { task_id: "owned", timeout: 400000 } }];
  normalizeClaudeLongCommands(context, calls);
  expect(calls[0].arguments).toEqual({ task_id: "owned", timeout: 30000 });
});

test("advertised long timeout defaults cannot bypass native task handoff", () => {
  const context = parsed();
  context.context.tools[0].parameters.properties.timeout = { type: "number", default: 120000 };
  context.context.tools[1].parameters.properties.timeout.default = 120000;
  const calls: any = [{ wireName: "Bash", arguments: { command: "owned-command" } },
    { wireName: "TaskOutput", arguments: { task_id: "owned", block: true } }];
  normalizeClaudeLongCommands(context, calls);
  expect(calls[0].arguments).toEqual({ command: "owned-command", run_in_background: true });
  expect(calls[1].arguments).toEqual({ task_id: "owned", block: true, timeout: 30000 });
});

test("captured modern Claude Bash/Read shape permits handoff without inventing a timeout", () => {
  const context: any = { context: { tools: [
    { name: "Bash", parameters: { properties: { command: { type: "string" }, timeout: { type: "number" }, run_in_background: { type: "boolean" } } } },
    { name: "Read", parameters: { properties: { file_path: { type: "string" } } } },
  ] } };
  const calls: any = [{ wireName: "Bash", arguments: { command: "node long-operation.mjs" } },
    { wireName: "Bash", arguments: { command: "bounded", timeout: 30000 } }];
  normalizeClaudeLongCommands(context, calls);
  expect(calls[0].arguments).toEqual({ command: "node long-operation.mjs", run_in_background: true });
  expect(calls[0].arguments).not.toHaveProperty("timeout");
  expect(calls[1].arguments).toEqual({ command: "bounded", timeout: 30000 });
});

test("explicit foreground intent is never silently converted to background", () => {
  for (const timeout of [undefined, 30000, 400000]) {
    const args = { command: "owned-command", run_in_background: false, ...(timeout === undefined ? {} : { timeout }) };
    const calls: any = [{ wireName: "Bash", arguments: args }];
    normalizeClaudeLongCommands(parsed(), calls);
    expect(calls[0].arguments).toEqual(args);
  }
});

test("a generic Read without file_path does not advertise background output support", () => {
  const context = parsed(true, false);
  context.context.tools.push({ name: "Read", parameters: { properties: {} } });
  const calls: any = [{ wireName: "Bash", arguments: { command: "owned-command" } }];
  const before = structuredClone(calls);
  normalizeClaudeLongCommands(context, calls);
  expect(calls).toEqual(before);
});

test("routing enables handoff only for identified Claude metadata", () => {
  for (const identity of [undefined, "false", false, true]) {
    const context = parsed();
    context._rawBody = { client_metadata: { claude_subagent: identity } };
    const calls: any = [{ wireName: "Bash", arguments: { command: "owned-command" } }];
    normalizeClaudeToolRequests(context, calls);
    expect(calls[0].arguments).toEqual(typeof identity === "boolean"
      ? { command: "owned-command", run_in_background: true }
      : { command: "owned-command" });
  }
});
