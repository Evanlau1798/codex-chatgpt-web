import { expect, spyOn, test } from "bun:test";
import * as tokenEstimate from "../src/lib/token-estimate";
import * as crypto from "node:crypto";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { TurnContextStore } from "../src/adapters/chatgpt-web/turn-context-store";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";

test.each([undefined, "visible prompt", "canonical history"])("worker reuses only identical inline message estimates (canonical=%s)", async canonical => {
  const estimate = spyOn(tokenEstimate, "estimateTokens");
  const log = spyOn(console, "error").mockImplementation(() => {});
  let released = false;
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  worker.config = {};
  const stop = new Error("preflight finished");
  worker.runStage = async (_trace: string, stage: string) => {
    expect(stage).toBe("browser_page"); throw stop;
  };
  try {
    const outcome = await worker.runBrowserTurn({
      traceId: "preflight-reuse", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "high",
      capabilities: { solAvailable: true, extraHighAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "visible prompt", images: [],
        modelInputText: canonical, release: () => { released = true; } }),
    }).catch((error: unknown) => error);
    expect(outcome).toBe(stop);
    expect(released).toBeTrue();
    expect(estimate.mock.calls.filter(([text]) => text === "visible prompt")).toHaveLength(1);
    expect(estimate.mock.calls.filter(([text]) => text === "canonical history")).toHaveLength(canonical === "canonical history" ? 1 : 0);
  } finally { estimate.mockRestore(); log.mockRestore(); }
});

test("shared inline count still includes full skill attachment tokens at the Luna input boundary", async () => {
  const text = "skill instructions ".repeat(15_000);
  const digest = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const prepared = { text: "task", images: [], skillFiles: [{ name: `fixture--${digest}.txt`, text }], release() {} };
  const expected = estimateCompiledChatGptWebInputTokens(prepared, CHATGPT_WEB_LUNA_MODEL_ID);
  expect(expected).toBeGreaterThan(28_000);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  worker.config = {};
  worker.runStage = () => { throw new Error("Must reject before browser access"); };
  try {
    await expect(worker.runBrowserTurn({ traceId: "skill-budget", modelId: CHATGPT_WEB_LUNA_MODEL_ID,
      reasoning: "medium", capabilities: { solAvailable: false, proAvailable: false }, prepare: async () => prepared,
    })).rejects.toThrow(`requires ${expected.toLocaleString("en-US")} estimated input tokens`);
  } finally { log.mockRestore(); }
});

test("immutable archive digest is computed once across pages and replays, with order and revocation intact", () => {
  const store = new TurnContextStore();
  const hash = spyOn(crypto, "createHash");
  const log = spyOn(console, "info").mockImplementation(() => {});
  const text = "first line\nsecond line\nthird line\n";
  try {
    const token = store.register(text);
    const first: any = store.read(token, 0, 12, new Map());
    expect(() => store.read(token, 2, 12, new Map())).toThrow("out of order");
    expect(store.read(token, 0, 12, new Map())).toEqual(first);
    const second: any = store.read(token, 1, 12, new Map());
    const third: any = store.read(token, 2, 12, new Map());
    expect(second.sha256).toBe(first.sha256);
    expect(third.sha256).toBe(first.sha256);
    expect(first.context + second.context + third.context).toBe(text);
    expect(hash).toHaveBeenCalledTimes(1);
    store.revoke(token);
    expect(() => store.read(token, 0, 12, new Map())).toThrow("invalid, expired, or revoked");
    const replacement = store.register("changed line\n");
    const changed: any = store.read(replacement, 0, 20, new Map());
    expect(changed.sha256).not.toBe(first.sha256);
    expect(hash).toHaveBeenCalledTimes(2);
  } finally { hash.mockRestore(); log.mockRestore(); store.clear(); }
});
