import { expect, test } from "bun:test";
import { normalizeClaudeLongCommands } from "../src/adapters/chatgpt-web/claude-long-command";

const parsed = (background = true, output = true): any => ({ context: { tools: [
  { name: "Bash", parameters: { properties: background ? { run_in_background: { type: "boolean" } } : {} } },
  ...(output ? [{ name: "TaskOutput", parameters: { properties: { timeout: { type: "number" } } } }] : []),
] } });

test("long Bash retains exact command and lifetime while native task owns completion", () => {
  const requests: any = [
    { wireName: "Bash", freeform: false, arguments: { command: "sleep 330; echo READY", timeout: 400000, run_in_background: false } },
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
