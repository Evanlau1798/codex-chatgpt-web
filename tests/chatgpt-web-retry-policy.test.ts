import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  MAX_CHATGPT_WEB_TURN_RETRIES,
  ChatGptWebTurnRetryPolicy,
} from "../src/adapters/chatgpt-web/retry-policy";
import { chatGptTurnRetryKey } from "../src/adapters/chatgpt-web/turn-retry-identity";
import type { CodexParsedRequest } from "../src/types";

function request(claudeRequestHash: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "claude_session",
          turn_id: "claude_root",
          request_kind: "turn",
        }),
        claude_subagent: false,
        claude_request_hash: claudeRequestHash,
      },
    },
  };
}

const retryableError = new ChatGptWebAdapterError("retry", {
  status: 502,
  errorType: "server_error",
  code: "upstream_server_error",
  retryable: true,
});

test("scopes Claude retry exhaustion to one logical Messages request", () => {
  const first = request("request-a");
  const repeatedFirst = request("request-a");
  const second = request("request-b");

  const firstKey = chatGptTurnRetryKey(first);
  expect(chatGptTurnRetryKey(repeatedFirst)).toBe(firstKey);
  expect(chatGptTurnRetryKey(second)).not.toBe(firstKey);

  const policy = new ChatGptWebTurnRetryPolicy();
  for (let attempt = 0; attempt <= MAX_CHATGPT_WEB_TURN_RETRIES; attempt += 1) {
    policy.recordRetryableFailure(firstKey, retryableError, attempt);
  }

  expect(policy.exhaustedError(firstKey, MAX_CHATGPT_WEB_TURN_RETRIES + 1)).toBeDefined();
  expect(policy.exhaustedError(chatGptTurnRetryKey(second), MAX_CHATGPT_WEB_TURN_RETRIES + 1)).toBeUndefined();
});

test("keeps native Codex retry identity stable without Claude metadata", () => {
  const native = request("ignored");
  delete (native._rawBody as { client_metadata: Record<string, unknown> })
    .client_metadata.claude_subagent;

  const changed = structuredClone(native);
  (changed._rawBody as { client_metadata: Record<string, unknown> })
    .client_metadata.claude_request_hash = "changed-but-not-claude";

  expect(chatGptTurnRetryKey(changed)).toBe(chatGptTurnRetryKey(native));
});
