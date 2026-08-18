import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptToolEvidenceGuard, hasUnsupportedNativeToolCauseClaim } from "../src/adapters/chatgpt-web/tool-evidence-guard";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function request(root: string): CodexParsedRequest {
  const turnId = "turn_tool_evidence_retry";
  const threadId = "thread_tool_evidence_retry";
  const environment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  const tools = [{ name: "shell_command", description: "Run a command", parameters: { type: "object" } }];
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools,
      messages: [{ role: "user", content: "Run the requested E2E check", timestamp: 1 }],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the requested E2E check" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  };
}

test("ordinary Codex tool turns retry unsupported safety-block claims before finalizing", async () => {
  const root = join(tmpdir(), `cgw-tool-evidence-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const socketPath = process.platform === "win32"
    ? defaultBrokerEndpoint(root, "win32")
    : join(root, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://tool-evidence-retry-test",
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode: false,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let captured: BrowserTurn | undefined;
  worker.run = async turn => {
    captured = turn;
    const prepared = await turn.prepare();
    prepared.release();
    turn.onTextDelta("Corrected final answer");
    return "Corrected final answer";
  };

  try {
    await createChatGptWebAdapter(provider).runTurn!(request(root), { headers: new Headers() }, () => {});
    const retry = await captured?.retryPromptForAnswer?.(
      "The E2E helper invocation was blocked by OpenAI safety checks before it ran.",
      1,
    );
    expect(retry).toMatchObject({ replaceCandidate: true });
    expect(typeof retry === "string" ? retry : retry?.text).toContain("Native tool error");
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported safety-block commentary is withheld and forces a corrected answer", async () => {
  const root = join(tmpdir(), `cgw-tool-evidence-commentary-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const socketPath = process.platform === "win32"
    ? defaultBrokerEndpoint(root, "win32")
    : join(root, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://tool-evidence-commentary-test",
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode: false,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const events: AdapterEvent[] = [];
  let retry: Awaited<ReturnType<NonNullable<BrowserTurn["retryPromptForAnswer"]>>>;
  worker.run = async turn => {
    const prepared = await turn.prepare();
    prepared.release();
    turn.onCommentary?.("最終 candidate 的完整 E2E helper 呼叫被工具安全檢查擋下，因此實際沒有執行。");
    retry = await turn.retryPromptForAnswer?.("Gate 20 remains open.", 1);
    turn.onTextDelta("Gate 20 remains open because the E2E action did not execute.");
    return "Gate 20 remains open because the E2E action did not execute.";
  };

  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(root),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(retry).toMatchObject({ replaceCandidate: true });
    expect(events.some(event => event.type === "text_delta"
      && event.phase === "commentary"
      && event.text.includes("安全檢查擋下"))).toBe(false);
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Native policy errors support matching blocking claims", () => {
  const guard = new ChatGptToolEvidenceGuard();
  guard.observeToolResult({
    role: "toolResult",
    toolCallId: "call_policy",
    toolName: "shell_command",
    content: "Execution was rejected by the local security policy",
    isError: true,
    timestamp: 1,
  });

  const claim = "The shell command was rejected by the security policy.";
  expect(guard.shouldEmitCommentary(claim)).toBe(true);
  expect(guard.retryPromptForAnswer(claim)).toBeUndefined();
});

test("ordinary tool failures do not justify a safety attribution", () => {
  const guard = new ChatGptToolEvidenceGuard();
  guard.observeToolResult({
    role: "toolResult",
    toolCallId: "call_exit",
    toolName: "shell_command",
    content: "Exit code: 1\nOutput:\ncommand failed",
    isError: true,
    timestamp: 1,
  });

  const claim = "The shell command was blocked by a safety policy before it ran.";
  expect(guard.shouldEmitCommentary(claim)).toBe(false);
  expect(guard.retryPromptForAnswer("The action did not execute.")).toMatchObject({ replaceCandidate: true });
});

test("cause detection accepts negated evidence statements and catches observed Chinese wording", () => {
  expect(hasUnsupportedNativeToolCauseClaim(
    "Without a Native tool error, I cannot say the command was blocked by safety checks.",
  )).toBe(false);
  expect(hasUnsupportedNativeToolCauseClaim(
    "部署命令第一次因工具無法判定安全狀態而未執行。",
  )).toBe(true);
});

test("repeated unsupported blocking claims fail closed after bounded corrections", () => {
  const guard = new ChatGptToolEvidenceGuard();
  const claim = "The helper invocation was blocked by OpenAI safety checks.";
  expect(guard.retryPromptForAnswer(claim)).toMatchObject({ replaceCandidate: true });
  expect(guard.retryPromptForAnswer(claim)).toMatchObject({ replaceCandidate: true });
  expect(() => guard.retryPromptForAnswer(claim)).toThrow("repeatedly attributed");
});
