import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";

const primary = resolve("workspace-primary");
const additional = resolve("workspace-additional");
function request(markup: string, workspaces: Record<string, unknown> = { [primary]: {} }): CodexParsedRequest {
  const environment = `<environment_context>${markup}<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  return {
    modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
    context: { messages: [{ role: "user", content: "Inspect the workspace", timestamp: 1 }] },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_current", turn_id: "turn_current", sandbox: "none", workspaces,
      }) },
      input: [environment, "Inspect the workspace"].map((text, index) => ({
        type: "message", id: `msg_${index}`, role: "user", content: [{ type: "input_text", text }],
      })),
    },
  };
}

test("Codex 0.150 filesystem-only multi-folder context uses its first workspace root", () => {
  expect(extractChatGptTurnEnvironment(request(
    `<filesystem><workspace_roots><root>${primary}</root><root>${additional}</root></workspace_roots></filesystem>`,
  ))).toEqual({
    cwd: primary, roots: [primary, additional], writableRoots: [primary, additional],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  });
});

test("projectless filesystem-only context does not require git workspace metadata", () => {
  expect(extractChatGptTurnEnvironment(request(
    `<filesystem><workspace_roots><root>${primary}</root></workspace_roots></filesystem>`, {},
  )).cwd).toBe(primary);
});

for (const malformed of [
  `<cwd/><workspace_roots><root>${primary}</root></workspace_roots>`,
  `<workspace_roots><root/><root>${primary}</root></workspace_roots>`,
  `<workspace_roots><root>${primary}</root></workspace_roots><workspace_roots><root>${additional}</root></workspace_roots>`,
]) test(`cwd recovery rejects malformed or ambiguous markup: ${malformed.split(">")[0]}`, () => {
  expect(() => extractChatGptTurnEnvironment(request(malformed))).toThrow("missing cwd");
});

test("explicit cwd remains authoritative over workspace-root order", () => {
  expect(extractChatGptTurnEnvironment(request(
    `<cwd>${additional}</cwd><workspace_roots><root>${primary}</root><root>${additional}</root></workspace_roots>`,
    { [additional]: {} },
  )).cwd).toBe(additional);
});
