import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ChatGptWebAdapterError,
  chatGptSessionFailureDisposition,
  chatGptWebSurfaceError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { isTemporaryChatGptUrl } from "../src/chatgpt-session";

describe("ChatGPT Web surface resilience", () => {
  test("retires surface failures even when a partial stream makes them unsafe to retry", () => {
    const surface = chatGptWebSurfaceError("surface changed", true);
    expect(surface).toMatchObject({
      code: "chatgpt_surface_changed",
      retryable: false,
      retireSession: true,
    });
    expect(chatGptSessionFailureDisposition(surface)).toBe("retire");

    const request = new ChatGptWebAdapterError("context too long", {
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    });
    expect(chatGptSessionFailureDisposition(request)).toBe("replay");
  });

  test("retries one fresh surface only before the prompt was submitted", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: () => Promise<string> }).runExclusive = async () => {
      attempts += 1;
      if (attempts === 1) throw chatGptWebSurfaceError("surface changed", false);
      return "recovered";
    };
    const turn = {
      traceId: "surface-retry",
      modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    } as BrowserTurn;

    expect(await worker.run(turn)).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("classifies a frozen send stage as a recoverable unsubmitted surface failure", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    const runStage = (worker as unknown as {
      runStage<T>(
        traceId: string,
        stage: string,
        timeoutMs: number,
        action: (signal: AbortSignal) => Promise<T>,
      ): Promise<T>;
    }).runStage.bind(worker);

    await expect(runStage(
      "frozen-send",
      "send",
      1,
      () => new Promise<string>(() => {}),
    )).rejects.toMatchObject({
      code: "chatgpt_surface_changed",
      retryable: true,
      retireSession: true,
    });
  });

  test("does not retry a fresh surface after text was streamed", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: () => Promise<string> }).runExclusive = async () => {
      attempts += 1;
      throw chatGptWebSurfaceError("surface changed", true);
    };

    await expect(worker.run({
      traceId: "surface-no-retry",
      modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    } as BrowserTurn)).rejects.toMatchObject({
      code: "chatgpt_surface_changed",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  test("does not retry a fresh surface after the prompt was submitted", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: (turn: BrowserTurn) => Promise<string> }).runExclusive = async turn => {
      attempts += 1;
      turn.onSubmitted?.();
      throw chatGptWebSurfaceError("surface changed", false);
    };

    await expect(worker.run({
      traceId: "surface-submitted-no-retry",
      modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    } as BrowserTurn)).rejects.toMatchObject({ code: "chatgpt_surface_changed" });
    expect(attempts).toBe(1);
  });

  test("does not retry a fresh surface after the Send control was activated", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    let activated = false;
    type ActivationAwareTurn = BrowserTurn & { onSendActivated?: () => void };
    (worker as unknown as { runExclusive: (turn: ActivationAwareTurn) => Promise<string> }).runExclusive = async turn => {
      attempts += 1;
      if (attempts === 1) {
        turn.onSendActivated?.();
        throw chatGptWebSurfaceError("submission evidence disappeared after Send activation", false);
      }
      return "duplicate submission";
    };

    const result = worker.run({
      traceId: "surface-send-activated-no-retry",
      modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      onSendActivated: () => { activated = true; },
    } as ActivationAwareTurn);

    await expect(result).rejects.toMatchObject({ code: "chatgpt_surface_changed" });
    expect(activated).toBeTrue();
    expect(attempts).toBe(1);
  });

  test("leaves tool-capable fresh-surface recovery to the adapter", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: () => Promise<string> }).runExclusive = async () => {
      attempts += 1;
      throw chatGptWebSurfaceError("surface changed", false);
    };

    await expect(worker.run({
      traceId: "tool-surface-adapter-recovery",
      modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high",
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    } as BrowserTurn)).rejects.toMatchObject({ code: "chatgpt_surface_changed" });
    expect(attempts).toBe(1);
  });

  test("retries one fresh surface when ChatGPT explicitly rejects the bound connector", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: () => Promise<string> }).runExclusive = async () => {
      attempts += 1;
      if (attempts === 1) throw new ChatGptWebAdapterError("api_tool unavailable", {
        status: 502,
        errorType: "server_error",
        code: "chatgpt_connector_unavailable",
        retryable: true,
        retireSession: true,
      });
      return "recovered";
    };

    expect(await worker.run({
      traceId: "connector-fresh-retry",
      modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high",
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    } as BrowserTurn)).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("recognizes the Temporary Chat route while allowing harmless query parameters", () => {
    expect(isTemporaryChatGptUrl("https://chatgpt.com/?temporary-chat=true&model=gpt-5")).toBe(true);
    expect(isTemporaryChatGptUrl("https://chatgpt.com/c/changed")).toBe(false);
    expect(isTemporaryChatGptUrl("not a URL")).toBe(false);
  });

  test("keeps a final plain-text fallback and the surface retirement bit across the helper", () => {
    const worker = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
    const helperMain = readFileSync(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url), "utf8");
    const helperClient = readFileSync(new URL("../src/adapters/chatgpt-web/launcher-helper-client.ts", import.meta.url), "utf8");

    expect(worker).toContain("plainTextFallback");
    expect(worker).toContain("response-dom-rebound");
    expect(worker).toContain("failure instanceof ChatGptWebAdapterError && failure.retireSession");
    expect(helperMain).toContain("retireSession: error.retireSession");
    expect(helperClient).toContain("retireSession: message.retireSession === true");
  });
});
