import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ChatGptWebAdapterError,
  chatGptSessionFailureDisposition,
  chatGptWebSurfaceError,
} from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { isTemporaryChatGptUrl } from "../src/chatgpt-session";

describe("ChatGPT Web surface resilience", () => {
  test("keeps a streamed prefix when ChatGPT merges roots while the answer grows", () => {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
    expect(buffer.observe([
      { key: "0:p", html: "<p>First.</p>", text: "First.", streamable: true },
      { key: "1:p", html: "<p>Second.</p>", text: "Second.", streamable: false },
    ], 0)).toBe("First.");

    expect(buffer.observe([{
      key: "0:root",
      html: "<p>First.</p><p>Second.</p><p>Third.</p>",
      text: "First.\n\nSecond.\n\nThird.",
      streamable: false,
    }], 1)).toBe("");
    expect(buffer.finish()).toEqual({
      markdown: "First.\n\nSecond.\n\nThird.",
      delta: "\n\nSecond.\n\nThird.",
    });
  });

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

  test("retries one fresh surface only before any text was streamed", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: () => Promise<string> }).runExclusive = async () => {
      attempts += 1;
      if (attempts === 1) throw chatGptWebSurfaceError("surface changed", false);
      return "recovered";
    };
    const turn = { traceId: "surface-retry" } as BrowserTurn;

    expect(await worker.run(turn)).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("does not retry a fresh surface after text was streamed", async () => {
    const Worker = ChatGptBrowserWorker as unknown as new (config: object) => ChatGptBrowserWorker;
    const worker = new Worker({ browserHost: "managed-chrome" });
    let attempts = 0;
    (worker as unknown as { runExclusive: () => Promise<string> }).runExclusive = async () => {
      attempts += 1;
      throw chatGptWebSurfaceError("surface changed", true);
    };

    await expect(worker.run({ traceId: "surface-no-retry" } as BrowserTurn)).rejects.toMatchObject({
      code: "chatgpt_surface_changed",
      retryable: false,
    });
    expect(attempts).toBe(1);
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
