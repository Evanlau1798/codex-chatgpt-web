import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHATGPT_MODEL_RECEIPT_MAX_EVENTS,
  ChatGptModelReceiptCollector,
  ChatGptModelReceiptObserver,
} from "../src/adapters/chatgpt-web/model-receipt";

test("network observation uses bounded Chromium streaming, never response-body materialization", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/model-receipt.ts", import.meta.url), "utf8");
  expect(source).toContain("Network.streamResourceContent");
  expect(source).toContain("Network.dataReceived");
  expect(source).not.toContain("response.body()");
});

test("full assistant-message metadata keeps requested/default/model/resolved separate", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({
    conversation_id: "conversation-1",
    message: {
      id: "message-1",
      author: { role: "assistant" },
      content: { parts: ["resolved_model_slug: fake-prose-never-recorded"] },
      metadata: {
        default_model_slug: "gpt-6-auto-thinking",
        requested_model_slug: "gpt-6-pro-thinking",
        model_slug: "gpt-6-pro-thinking",
        resolved_model_slug: "gpt-6-pro",
      },
    },
  });
  expect(collector.finish()).toEqual({
    status: "resolved",
    metadata: {
      defaultModelSlug: "gpt-6-auto-thinking",
      requestedModelSlug: "gpt-6-pro-thinking",
      modelSlug: "gpt-6-pro-thinking",
      resolvedModelSlug: "gpt-6-pro",
      conversationId: "conversation-1",
      messageId: "message-1",
    },
    evidenceCount: 1,
    malformedFields: [],
    conflictingFields: [],
  });
  expect(JSON.stringify(collector.finish())).not.toContain("fake-prose-never-recorded");
});

test("delta patches and server stream metadata contribute only known authoritative fields", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ p: "/message/author/role", o: "replace", v: "assistant" });
  collector.consumeJson({ p: "/message/id", o: "replace", v: "message-delta" });
  collector.consumeJson({ p: "/message/metadata/default_model_slug", o: "replace", v: "gpt-6-auto-thinking" });
  collector.consumeJson({ p: "/message/metadata/requested_model_slug", o: "replace", v: "gpt-6-pro-thinking" });
  collector.consumeJson({ p: "/message/metadata/model_slug", o: "replace", v: "gpt-6-pro-thinking" });
  collector.consumeJson({
    type: "server_ste_metadata",
    metadata: { resolved_model_slug: "gpt-6-pro", effort: "max" },
  });
  expect(collector.finish()).toMatchObject({
    status: "resolved",
    metadata: {
      defaultModelSlug: "gpt-6-auto-thinking",
      requestedModelSlug: "gpt-6-pro-thinking",
      modelSlug: "gpt-6-pro-thinking",
      resolvedModelSlug: "gpt-6-pro",
    },
  });
});

test("a bare metadata delta without assistant message context is ignored", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ p: "/message/metadata/resolved_model_slug", o: "replace", v: "gpt-6-pro" });
  expect(collector.finish().status).toBe("unavailable");
});

test("a delta message identity change prevents later metadata from mixing two assistant turns", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ p: "/message/author/role", o: "replace", v: "assistant" });
  collector.consumeJson({ p: "/message/id", o: "replace", v: "message-one" });
  collector.consumeJson({ p: "/message/metadata/resolved_model_slug", o: "replace", v: "gpt-6-pro" });
  collector.consumeJson({ p: "/message/id", o: "replace", v: "message-two" });
  collector.consumeJson({ p: "/message/metadata/resolved_model_slug", o: "replace", v: "gpt-5-pro" });
  expect(collector.finish().status).toBe("conflict");
});

test("recognized full-message envelopes may carry known fields at top level metadata", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({
    conversation_id: "conversation-2",
    metadata: { requested_model_slug: "gpt-6-pro", resolved_model_slug: "gpt-6-pro" },
    message: { author: { role: "assistant" }, id: "message-2" },
  });
  expect(collector.finish()).toMatchObject({
    status: "resolved",
    metadata: { requestedModelSlug: "gpt-6-pro", resolvedModelSlug: "gpt-6-pro" },
  });
});

test("SSE parsing is incremental and supports a final data frame without a trailing blank line", () => {
  const collector = new ChatGptModelReceiptCollector();
  const first = 'event: message\ndata: {"message":{"author":{"role":"assistant"},"metadata":{"requested_model_slug":"gpt-6-pro"}}}\n\n';
  const second = 'data: {"message":{"author":{"role":"assistant"},"metadata":{"resolved_model_slug":"gpt-6-pro"}}}';
  collector.consumeSseChunk(first.slice(0, 29));
  collector.consumeSseChunk(first.slice(29));
  collector.consumeSseChunk(second, true);
  expect(collector.finish()).toMatchObject({
    status: "resolved",
    metadata: { requestedModelSlug: "gpt-6-pro", resolvedModelSlug: "gpt-6-pro" },
  });
});

test("missing, malformed, and conflicting resolved metadata never invent a served model", () => {
  const missing = new ChatGptModelReceiptCollector();
  missing.consumeJson({ message: { author: { role: "assistant" }, metadata: { model_slug: "gpt-6-pro" } } });
  expect(missing.finish().status).toBe("unavailable");

  const malformed = new ChatGptModelReceiptCollector();
  malformed.consumeJson({ message: { author: { role: "assistant" }, metadata: { resolved_model_slug: "not a slug" } } });
  expect(malformed.finish().status).toBe("malformed");

  const conflicting = new ChatGptModelReceiptCollector();
  conflicting.consumeJson({ message: { author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } } });
  conflicting.consumeJson({ type: "server_ste_metadata", metadata: { resolved_model_slug: "gpt-5.6-pro" } });
  expect(conflicting.finish()).toMatchObject({ status: "conflict", conflictingFields: ["resolved_model_slug"] });
});

test("ordinary user/assistant prose and unrelated attachment metadata are ignored", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({
    message: {
      author: { role: "user" },
      content: { parts: [{ text: '{"resolved_model_slug":"gpt-6-pro"}' }] },
      metadata: { attachment_name: "resolved_model_slug-gpt-6-pro.txt" },
    },
  });
  collector.consumeJson({ type: "attachment_progress", metadata: { resolved_model_slug: "gpt-6-pro" } });
  expect(collector.finish().status).toBe("unavailable");
});

test("the collector stops at its event bound", () => {
  const collector = new ChatGptModelReceiptCollector();
  for (let index = 0; index < CHATGPT_MODEL_RECEIPT_MAX_EVENTS + 1; index += 1) {
    collector.consumeJson({ type: "unrelated", value: index });
  }
  expect(collector.finish().status).toBe("bounded");
});

test("truncated message and mapping collections are bounded rather than accepted", () => {
  const messages = Array.from({ length: CHATGPT_MODEL_RECEIPT_MAX_EVENTS + 1 }, () => ({
    author: { role: "assistant" },
    metadata: { resolved_model_slug: "gpt-6-pro" },
  }));
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ messages });
  expect(collector.finish().status).toBe("bounded");
});

class FakePage {
  readonly frame = {};
  constructor(readonly cdp = new FakeCdp()) {}
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  mainFrame() { return this.frame; }
  context() { return { newCDPSession: async () => this.cdp }; }
  on(event: string, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: (value: unknown) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

class FakeCdp {
  detached = false;
  private readonly listeners = new Map<string, Set<(value: any) => void>>();
  on(event: string, listener: (value: any) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: (value: any) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
  async send(method: string) {
    if (method === "Network.streamResourceContent") return { bufferedData: "" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    return {};
  }
  listenerCount(event: string) { return this.listeners.get(event)?.size ?? 0; }
  async detach() { this.detached = true; this.listeners.clear(); }
}

class FailingCdp extends FakeCdp {
  async send(method: string) {
    if (method === "Network.enable") throw new Error("offline CDP enable failure");
    return super.send(method);
  }
}

class FakeRequest {
  constructor(
    private readonly page: FakePage,
    private readonly body: Record<string, unknown>,
    private readonly owned = true,
  ) {}
  method() { return "POST"; }
  url() { return "https://chatgpt.com/backend-api/f/conversation"; }
  frame() { return this.owned ? this.page.frame : {}; }
  postDataJSON() { return this.body; }
  postData() { return JSON.stringify(this.body); }
}

function resolvedSse(served: string, conversation = "conversation-1", messageId = `message-${served}`) {
  return `data: ${JSON.stringify({
    conversation_id: conversation,
    message: { id: messageId, author: { role: "assistant" }, metadata: { resolved_model_slug: served } },
  })}\n\n`;
}

function emitNetworkResponse(page: FakePage, requestId: string, body: string, contentType = "text/event-stream") {
  page.cdp.emit("Network.responseReceived", {
    requestId,
    response: { status: 200, headers: { "content-type": contentType } },
  });
  page.cdp.emit("Network.dataReceived", { requestId, data: Buffer.from(body).toString("base64") });
  page.cdp.emit("Network.loadingFinished", { requestId });
}

function emitOwnedNetwork(page: FakePage, request: FakeRequest, requestId: string, body: string, contentType = "text/event-stream") {
  page.emit("request", request);
  page.cdp.emit("Network.requestWillBeSent", {
    requestId,
    frameId: "main",
    request: { method: "POST", url: request.url(), postData: request.postData() },
  });
  emitNetworkResponse(page, requestId, body, contentType);
}

test("observer rejects stale/foreign responses and emits one hashed receipt per physical Send", async () => {
  const page = new FakePage();
  const receipts: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver(
    "trace_receipt",
    "chatgpt-web/gpt-6-pro",
    "gpt-5.6-sol",
    receipt => receipts.push(receipt),
  );
  await observer.attach(page as never);

  const stale = new FakeRequest(page, { model: "stale" });
  page.emit("request", stale);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  page.cdp.emit("Network.requestWillBeSent", {
    requestId: "stale",
    frameId: "main",
    request: { method: "POST", url: stale.url(), postData: stale.postData() },
  });
  emitNetworkResponse(page, "stale", resolvedSse("gpt-5-stale"));
  await observer.flushCurrent();
  expect(receipts).toHaveLength(0);

  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const foreign = new FakeRequest(page, { model: "foreign" }, false);
  page.emit("request", foreign);
  await observer.flushCurrent();
  expect(receipts).toHaveLength(0);

  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const owned = new FakeRequest(page, { model: "gpt-6-pro", conversation_id: "conversation-1" });
  emitOwnedNetwork(page, owned, "owned", resolvedSse("gpt-6-pro"));
  await observer.flushCurrent();
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    physicalSend: 3,
    responseAttempt: 1,
    requestedModel: "chatgpt-web/gpt-6-pro",
    backendContextModel: "gpt-5.6-sol",
    browserRequestModel: "gpt-6-pro",
    servedModel: "gpt-6-pro",
    source: "network.resolved_model_slug",
  });
  expect(receipts[0]).not.toHaveProperty("conversationId");
  expect(receipts[0]).toHaveProperty("conversationIdHash");

  observer.beginSend({ responseAttempt: 2, provenance: "response_retry" });
  observer.activate();
  const retry = new FakeRequest(page, { model: "gpt-6-pro", conversation_id: "conversation-1" });
  emitOwnedNetwork(page, retry, "retry", resolvedSse("gpt-6-pro"));
  await observer.flushCurrent();
  expect(receipts).toHaveLength(2);
  expect(receipts[1]).toMatchObject({ physicalSend: 4, responseAttempt: 2, provenance: "response_retry" });
});

test("observer does not fabricate a receipt for a foreign conversation or a prose marker", async () => {
  const page = new FakePage();
  const receipts: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_foreign", "chatgpt-web/high", undefined, receipt => receipts.push(receipt));
  await observer.attach(page as never);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const request = new FakeRequest(page, { model: "high", conversation_id: "owned-conversation" });
  emitOwnedNetwork(page, request, "foreign", `data: ${JSON.stringify({
    conversation_id: "foreign-conversation",
    message: { id: "foreign-message", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } },
  })}\n\n`);
  await observer.flushCurrent();
  expect(receipts).toHaveLength(0);
});

test("headerless SSE remains incrementally observable after a 2.1-second transport gap", async () => {
  const page = new FakePage();
  const receipts: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_long_sse", "chatgpt-web/gpt-6-pro", undefined, receipt => receipts.push(receipt));
  await observer.attach(page as never);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const request = new FakeRequest(page, { model: "gpt-6-pro" });
  page.emit("request", request);
  page.cdp.emit("Network.requestWillBeSent", {
    requestId: "long",
    frameId: "main",
    request: { method: "POST", url: request.url(), postData: request.postData() },
  });
  page.cdp.emit("Network.responseReceived", {
    requestId: "long",
    response: { status: 200, headers: { "content-type": "text/event-stream" } },
  });
  await Bun.sleep(2_100);
  page.cdp.emit("Network.dataReceived", { requestId: "long", data: Buffer.from(resolvedSse("gpt-6-pro")).toString("base64") });
  page.cdp.emit("Network.loadingFinished", { requestId: "long" });
  await observer.flushCurrent();
  expect(receipts).toHaveLength(1);
});

test("DOM completion can precede loadingFinished; terminal telemetry drains afterward", async () => {
  const page = new FakePage();
  const receipts: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_terminal_drain", "chatgpt-web/gpt-6-pro", undefined, receipt => receipts.push(receipt));
  await observer.attach(page as never);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const request = new FakeRequest(page, { model: "gpt-6-pro" });
  page.emit("request", request);
  page.cdp.emit("Network.requestWillBeSent", {
    requestId: "drain",
    frameId: "main",
    request: { method: "POST", url: request.url(), postData: request.postData() },
  });
  page.cdp.emit("Network.responseReceived", {
    requestId: "drain",
    response: { status: 200, headers: { "content-type": "text/event-stream" } },
  });
  page.cdp.emit("Network.dataReceived", { requestId: "drain", data: Buffer.from(resolvedSse("gpt-6-pro")).toString("base64") });
  await observer.flushCurrent();
  expect(receipts).toHaveLength(0);
  page.cdp.emit("Network.loadingFinished", { requestId: "drain" });
  await observer.dispose();
  expect(receipts).toHaveLength(1);
});

test("encoded byte caps stop further parsing without cancelling the owned network request", async () => {
  const page = new FakePage();
  const receipts: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_cap", "chatgpt-web/gpt-6-pro", undefined, receipt => receipts.push(receipt));
  await observer.attach(page as never);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const request = new FakeRequest(page, { model: "gpt-6-pro" });
  page.emit("request", request);
  page.cdp.emit("Network.requestWillBeSent", {
    requestId: "cap",
    frameId: "main",
    request: { method: "POST", url: request.url(), postData: request.postData() },
  });
  page.cdp.emit("Network.responseReceived", {
    requestId: "cap",
    response: { status: 200, headers: { "content-type": "text/event-stream" } },
  });
  const oversized = Buffer.alloc(2_000_001).toString("base64");
  page.cdp.emit("Network.dataReceived", { requestId: "cap", data: oversized });
  page.cdp.emit("Network.loadingFinished", { requestId: "cap" });
  await observer.dispose();
  expect(receipts).toHaveLength(0);
});

test("a partial CDP initialization is detached without escaping attach", async () => {
  const cdp = new FailingCdp();
  const observer = new ChatGptModelReceiptObserver("trace_init_failure", "chatgpt-web/gpt-6-pro", undefined);
  await observer.attach(new FakePage(cdp) as never);
  expect(cdp.detached).toBeTrue();
  expect(cdp.listenerCount("Network.responseReceived")).toBe(0);
  await observer.dispose();
});

test("collector rejection is telemetry-only and does not reject the transport observer", async () => {
  const page = new FakePage();
  const observer = new ChatGptModelReceiptObserver("trace_collector_failure", "chatgpt-web/gpt-6-pro", undefined);
  const original = ChatGptModelReceiptCollector.prototype.consumeSseChunk;
  ChatGptModelReceiptCollector.prototype.consumeSseChunk = () => { throw new Error("fixture decoder failure"); };
  try {
    await observer.attach(page as never);
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const request = new FakeRequest(page, { model: "gpt-6-pro" });
    emitOwnedNetwork(page, request, "collector-failure", resolvedSse("gpt-6-pro"));
    await observer.flushCurrent();
  } finally {
    ChatGptModelReceiptCollector.prototype.consumeSseChunk = original;
    await observer.dispose();
  }
});

test("multiple owned responses with different message IDs do not select the first model receipt", async () => {
  const page = new FakePage();
  const receipts: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_conflicting_ids", "chatgpt-web/gpt-6-pro", undefined, receipt => receipts.push(receipt));
  await observer.attach(page as never);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  const first = new FakeRequest(page, { model: "gpt-6-pro", conversation_id: "conversation-1" });
  const second = new FakeRequest(page, { model: "gpt-6-pro", conversation_id: "conversation-1" });
  emitOwnedNetwork(page, first, "first", resolvedSse("gpt-6-pro", "conversation-1", "message-first"));
  emitOwnedNetwork(page, second, "second", resolvedSse("gpt-6-pro", "conversation-1", "message-second"));
  await observer.flushCurrent();
  expect(receipts).toHaveLength(0);
});

test("a page rebind seals the old attempt and marks the next physical Send as surface recovery", async () => {
  const firstPage = new FakePage();
  const secondPage = new FakePage();
  const receipts: any[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_rebind", "chatgpt-web/gpt-6-pro", undefined, receipt => receipts.push(receipt));
  await observer.attach(firstPage as never);
  observer.beginSend({ responseAttempt: 1 });
  observer.activate();
  await observer.attach(secondPage as never);
  observer.beginSend({ responseAttempt: 2 });
  observer.activate();
  const request = new FakeRequest(secondPage, { model: "gpt-6-pro" });
  emitOwnedNetwork(secondPage, request, "recovered", resolvedSse("gpt-6-pro"));
  await observer.flushCurrent();
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ responseAttempt: 2, provenance: "surface_recovery" });
});

test("every activated Send gets one safe diagnostic outcome when CDP or metadata is unavailable", async () => {
  const noCdp = new ChatGptModelReceiptObserver("trace_no_cdp", "chatgpt-web/gpt-6-pro", undefined, undefined, undefined, diagnostic => {
    (noCdpDiagnostics as any[]).push(diagnostic);
  });
  const noCdpDiagnostics: unknown[] = [];
  await noCdp.attach({ on() {}, off() {}, mainFrame() { return {}; } } as never);
  noCdp.beginSend({ responseAttempt: 1 });
  noCdp.activate();
  await noCdp.flushCurrent();
  await noCdp.dispose();
  expect(noCdpDiagnostics).toMatchObject([{ outcome: "unavailable", reason: "cdp_unavailable" }]);

  const page = new FakePage();
  const missingDiagnostics: unknown[] = [];
  const missing = new ChatGptModelReceiptObserver("trace_no_metadata", "chatgpt-web/gpt-6-pro", undefined, undefined, undefined, diagnostic => missingDiagnostics.push(diagnostic));
  await missing.attach(page as never);
  missing.beginSend({ responseAttempt: 1 });
  missing.activate();
  const request = new FakeRequest(page, { model: "gpt-6-pro" });
  emitOwnedNetwork(page, request, "missing", `data: {"message":{"author":{"role":"assistant"},"content":{"parts":["no model metadata"]}}}\n\n`);
  await missing.flushCurrent();
  await missing.dispose();
  expect(missingDiagnostics).toMatchObject([{ outcome: "unavailable", reason: "missing_resolved_model" }]);
});
