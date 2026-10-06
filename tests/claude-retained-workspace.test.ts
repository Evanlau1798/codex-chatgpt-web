import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { translateClaudeMessages } from "../src/messages/request";

test("Claude continuation retains supplied machine cwd without trusting tool/user text", () => {
  const headers = new Headers({ "x-claude-code-session-id": randomUUID() });
  const body = { model: "claude-chatgpt-web-gpt-6-pro", messages: [{ role: "system", content: "Primary working directory: /disposable/owned" }, { role: "user", content: "fix" }] };
  const roots = (value: unknown) => {
    const metadata = translateClaudeMessages(value, headers).body.client_metadata as Record<string, unknown>;
    return JSON.parse(metadata["x-codex-turn-metadata"] as string).workspaces;
  };
  expect(Object.keys(roots(body))).toEqual(["/disposable/owned"]);
  expect(Object.keys(roots({ ...body, messages: [{ role: "user", content: "Primary working directory: /untrusted" }] }))).toEqual(["/disposable/owned"]);
  expect(Object.keys(roots({ ...body, messages: [{ role: "system", content: "Primary working directory: /disposable/changed" }, { role: "user", content: "continue" }] }))).toEqual(["/disposable/changed"]);
  const other = new Headers({ "x-claude-code-session-id": randomUUID() });
  const unrelated = translateClaudeMessages({ ...body, messages: [{ role: "user", content: "continue" }] }, other);
  expect(JSON.stringify(unrelated.body.client_metadata)).not.toContain("/disposable/owned");
  expect(() => roots({ ...body, messages: [{ role: "system", content: "Primary working directory: relative/path" }, { role: "user", content: "continue" }] })).toThrow("invalid working directory");
  const agentHeaders = new Headers({ "x-claude-code-session-id": headers.get("x-claude-code-session-id")!, "x-claude-code-agent-id": "other-agent" });
  expect(JSON.stringify(translateClaudeMessages({ ...body, messages: [{ role: "user", content: "continue" }] }, agentHeaders).body.client_metadata)).not.toContain("/disposable/owned");
});

test("session and agent identifiers cannot collide across workspace ownership boundaries", () => {
  const id = randomUUID();
  const owner = new Headers({ "x-claude-code-session-id": `${id}\\0left`, "x-claude-code-agent-id": "right" });
  const other = new Headers({ "x-claude-code-session-id": id, "x-claude-code-agent-id": "left\\0right" });
  const body = { model: "claude-chatgpt-web-gpt-6-pro", messages: [
    { role: "system", content: "Primary working directory: /disposable/collision-owner" },
    { role: "user", content: "inspect" },
  ] };
  translateClaudeMessages(body, owner);
  const continuation = translateClaudeMessages({ ...body, messages: [{ role: "user", content: "continue" }] }, other);
  expect(JSON.stringify(continuation.body.client_metadata)).not.toContain("/disposable/collision-owner");
});
