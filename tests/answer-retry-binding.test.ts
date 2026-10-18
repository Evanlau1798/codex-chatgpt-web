import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { defaultBrokerEndpoint } from "../src/config";
import { createChatGptRuntimeStarter } from "../src/adapters/chatgpt-web/adapter-runtime-factory";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptLunaCheckpointStore } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { EnhancedRecoveryCheckpointStore } from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

test("production answer corrections and steering retain the prepared Native work binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-answer-binding-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: false };
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  // Isolate only the external browser history; exercise the real identity validation.
  worker.reconcileMultipartHistory = async () => {};
  const page = { url: () => "https://chatgpt.com/?temporary-chat=true",
    locator: () => ({ evaluateAll: async () => [] }) };
  let runtime: ReturnType<ReturnType<typeof createChatGptRuntimeStarter>>;
  let release: () => void = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  let proceed: () => void = () => {};
  const started = new Promise<void>(resolve => { proceed = resolve; });
  try {
    await broker.listen();
    const starter = createChatGptRuntimeStarter({ provider: { adapter: "chatgpt-web", baseUrl: "http://localhost" },
      broker, brokerOwner: broker, configuredCapabilities: capabilities, executionNamespace: root,
      useEnhancedWebSessionMode: true, useEnhancedOutputTunnel: true,
      experimentalFreshConversationPerTurn: false, experimentalBiggerContext: false, experimentalSkillAttachments: false,
      lunaCheckpointStore: new ChatGptLunaCheckpointStore(), enhancedRecoveryCheckpointStore: new EnhancedRecoveryCheckpointStore(),
      worker: { async run(turn) {
        const prepared = await turn.prepare();
        release();
        await started;
        const token = prepared.turnToken!;
        for (const steering of [false, true]) {
          if (steering) runtime.steering!.push("Inspect one more file before answering.");
          const retry = await turn.retryPromptForAnswer!(steering ? "Complete." : "工具被安全政策拒絕", 1);
          expect(retry).toBeDefined();
          const text = typeof retry === "string" ? retry : retry!.text;
          if (!steering) expect(retry).toHaveProperty("replaceCandidate", true);
          expect(text).toContain(token);
          expect(text).not.toContain("All requested Codex Native2 work tools have completed");
          const baseline = await worker.captureSubmissionBaseline(page, text, [], token);
          expect(baseline.turnToken).toBe(token);
          await expect(worker.captureSubmissionBaseline(page, text, [], "turn_00000000000000000000000000000000"))
            .rejects.toThrow("submission identity does not match its prepared prompt");
        }
        expect(await turn.retryPromptForAnswer!("Complete without an unsupported claim.", 2)).toBeUndefined();
        return "Complete.";
      } } });
    const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: [{ type: "message", role: "user", content: "Review.",
      internal_chat_message_metadata_passthrough: { turn_id: "answer-binding" } }],
      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "answer-binding" }) } });
    runtime = starter(parsed, { cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools! }, "answer-binding", capabilities);
    await ready;
    proceed();
    expect(await runtime.browser).toBe("Complete.");
    if (runtime.mode === "tools") await broker.revoke(await runtime.token);
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
