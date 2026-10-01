import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHATGPT_MODEL_RECEIPT_MAX_EVENTS,
  ChatGptModelReceiptCollector,
  ChatGptModelReceiptObserver,
  replayChatGptMetadataTrace,
} from "../src/adapters/chatgpt-web/model-receipt";

test("network observation uses bounded Chromium streaming, never response-body materialization", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/model-receipt.ts", import.meta.url), "utf8");
  expect(source).toContain("Network.streamResourceContent");
  expect(source).toContain("Network.dataReceived");
  expect(source).not.toContain("response.body()");
});

test("recorded real GPT-6 Pro v-envelope resolves the assistant without binding the user stream ID", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/chatgpt-gpt6-pro-metadata.recorded.json", import.meta.url), "utf8"));
  const collector = new ChatGptModelReceiptCollector();
  for (const frame of fixture.frames) collector.consumeJson(frame);
  expect(collector.finish()).toMatchObject({ status: "resolved", metadata: {
    resolvedModelSlug: "gpt-6-pro", modelSlug: "gpt-6-pro", defaultModelSlug: "gpt-6-pro",
    messageId: fixture.frames[0].v.message.id,
  } });
});

test("non-assistant snapshots and content-patch values cannot inherit assistant metadata authority", () => {
  for (const payload of [
    { message: { author: { role: "user" } }, metadata: { resolved_model_slug: "fake-user-model" } },
    { p: "/message/content/parts/0", o: "replace", v: { message: { author: { role: "assistant" }, metadata: { resolved_model_slug: "fake-content-model" } } } },
  ]) {
    const collector = new ChatGptModelReceiptCollector();
    collector.consumeJson({ message: { id: "assistant-context", author: { role: "assistant" }, metadata: {} } });
    collector.consumeJson(payload);
    expect(collector.finish().status).toBe("unavailable");
  }
  const delta = new ChatGptModelReceiptCollector();
  delta.consumeJson({ message: { id: "assistant-context", author: { role: "assistant" } } });
  delta.consumeJson({ p: "/message/author/role", o: "replace", v: "user" });
  delta.consumeJson({ p: "/message/metadata/resolved_model_slug", o: "replace", v: "fake-user-model" });
  expect(delta.finish().status).toBe("unavailable");
});

test("user system tool and unbound ID deltas never supply an assistant identity", () => {
  for (const role of [undefined, "user", "system", "tool"]) {
    const collector = new ChatGptModelReceiptCollector();
    if (role !== undefined) collector.consumeJson({ p: "/message/author/role", o: "replace", v: role });
    collector.consumeJson({ p: "/message/id", o: "replace", v: "non-assistant-id" });
    collector.consumeJson({ type: "server_ste_metadata", metadata: { resolved_model_slug: "gpt-6-pro" } });
    expect(collector.finish().metadata.messageId).toBeUndefined();
  }
});

test("direct non-assistant snapshots clear the previous assistant delta authority", () => {
  for (const role of ["user", "system", "tool"]) {
    const collector = new ChatGptModelReceiptCollector();
    collector.consumeJson({ author: { role: "assistant" }, id: "assistant-id" });
    collector.consumeJson({ author: { role }, id: "non-assistant-id" });
    collector.consumeJson({ p: "/message/metadata/resolved_model_slug", o: "replace", v: "fake-non-assistant-model" });
    expect(collector.finish().status).toBe("unavailable");
    expect(collector.finish().metadata.resolvedModelSlug).toBeUndefined();
  }
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

test("sanitized frame recording preserves only bounded assistant metadata structure", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({
    message: {
      id: "message-private-id",
      author: { role: "assistant" },
      content: { parts: [{ text: "PRIVATE_PROMPT_OR_PROSE" }] },
      metadata: { resolved_model_slug: "gpt-6-pro", prompt: "PRIVATE_PROMPT_OR_PROSE" },
    },
    data: [{ p: "/message/metadata/resolved_model_slug", o: "replace", v: "gpt-6-pro" }],
    authorization: "Bearer PRIVATE_TOKEN",
    url: "https://private.invalid/conversation",
  });
  const trace = collector.diagnosticTrace();
  const serialized = JSON.stringify(trace);
  expect(serialized).toContain("gpt-6-pro");
  expect(serialized).not.toContain("PRIVATE_PROMPT_OR_PROSE");
  expect(serialized).not.toContain("PRIVATE_TOKEN");
  expect(serialized).not.toContain("private.invalid");
  expect(serialized).not.toContain("message-private-id");
  expect(trace.frames[0]).toMatchObject({ class: "message", role: "assistant", nested: expect.any(Array) });
  expect(trace.frames[0]!.ids?.messageIdHash).toMatch(/^[a-f0-9]{24}$/);
});

test("sanitized frame recording retains first/last bounded shapes only", () => {
  const collector = new ChatGptModelReceiptCollector();
  for (let index = 0; index < CHATGPT_MODEL_RECEIPT_MAX_EVENTS + 20; index += 1) {
    collector.consumeJson({ type: "unrelated", data: [{ index }] });
  }
  const trace = collector.diagnosticTrace();
  expect(trace.frames.length).toBeLessThanOrEqual(32);
  expect(trace.droppedFrames).toBeGreaterThan(0);
  expect(JSON.stringify(trace)).not.toContain("index");
  expect(trace.replayComplete).toBeFalse();
  expect(() => replayChatGptMetadataTrace(trace)).toThrow("incomplete");
});

test("metadata replay preserves nested batch hierarchy and every message identity without content", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ data: { v: [
    { message: { id: "first-private-message", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" }, content: { parts: ["PRIVATE_ANSWER"] } } },
    { message: { id: "second-private-message", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-thinking" } } },
  ] } });
  const trace = collector.diagnosticTrace();
  const fragment = trace.frames[0]!.fragment as any;
  expect(fragment.data.v).toHaveLength(2);
  expect(fragment.data.v[0].message.metadata.resolved_model_slug).toBe("gpt-6-pro");
  expect(fragment.data.v[1].message.metadata.resolved_model_slug).toBe("gpt-6-thinking");
  expect(fragment.data.v[0].message.id).not.toBe(fragment.data.v[1].message.id);
  expect(JSON.stringify(trace)).not.toContain("PRIVATE_ANSWER");
  expect(JSON.stringify(trace)).not.toContain("first-private-message");
  expect(trace.replayComplete).toBeTrue();
  // The current parser does not support this envelope; recording must not silently add authority.
  expect(replayChatGptMetadataTrace(trace).status).toBe(collector.finish().status);
  expect(collector.finish().status).toBe("unavailable");
});

test("metadata replay preserves exact delta field and malformed value type", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ message: { id: "delta-private-id", author: { role: "assistant" }, metadata: {} } });
  collector.consumeJson({ p: "/message/metadata/resolved_model_slug", o: "replace", v: 42 });
  const trace = collector.diagnosticTrace();
  expect(trace.frames[1]!.fragment).toEqual({ p: "/message/metadata/resolved_model_slug", o: "replace", v: 42 });
  expect(replayChatGptMetadataTrace(trace).status).toBe("malformed");
  expect(collector.finish().status).toBe("malformed");
});

test("metadata replay retains conflicts across all mapping entries and consistent hashed IDs", () => {
  const collector = new ChatGptModelReceiptCollector();
  collector.consumeJson({ mapping: {
    "mapping-private-one": { message: { id: "private-one", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } } },
    "mapping-private-two": { message: { id: "private-two", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-thinking" } } },
  } });
  const trace = collector.diagnosticTrace();
  expect(trace.replayComplete).toBeTrue();
  expect(Object.keys((trace.frames[0]!.fragment as any).mapping)).toHaveLength(2);
  expect(JSON.stringify(trace)).not.toContain("private-one");
  expect(replayChatGptMetadataTrace(trace).status).toBe("conflict");
  expect(collector.finish().status).toBe("conflict");
});

test("sensitive or truncated metadata is explicitly non-replayable instead of reconstructed", () => {
  const secret = "sk-private-credential-1234567890123456";
  for (const role of ["user", "assistant"]) {
    const collector = new ChatGptModelReceiptCollector();
    collector.consumeJson({ message: { author: { role }, metadata: { resolved_model_slug: secret }, content: { parts: [secret] } } });
    const trace = collector.diagnosticTrace();
    expect(JSON.stringify(trace)).not.toContain(secret);
    expect(trace.replayComplete).toBeFalse();
    expect(() => replayChatGptMetadataTrace(trace)).toThrow("incomplete");
  }
  const clipped = new ChatGptModelReceiptCollector();
  clipped.consumeJson({ data: Array.from({ length: 40 }, () => ({ message: { author: { role: "assistant" } } })) });
  expect(clipped.diagnosticTrace().replayComplete).toBeFalse();
  expect(() => replayChatGptMetadataTrace(clipped.diagnosticTrace())).toThrow("incomplete");
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

class FakeTeePage extends FakePage {
  async exposeBinding() {}
  async evaluate() {}
}

class FailingCdp extends FakeCdp {
  async send(method: string) {
    if (method === "Network.enable") throw new Error("offline CDP enable failure");
    return super.send(method);
  }
}

class DelayedAttachPage extends FakePage {
  private readonly sessionReady: Promise<FakeCdp>;
  private resolveSession!: (session: FakeCdp) => void;
  constructor(readonly delayedCdp: FakeCdp) {
    super(delayedCdp);
    this.sessionReady = new Promise(resolve => { this.resolveSession = resolve; });
  }
  override context() { return { newCDPSession: async () => this.sessionReady }; }
  releaseSession(): void { this.resolveSession(this.delayedCdp); }
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

test("recorded metadata survives a late transport abort only after an observed provider DONE marker", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/chatgpt-gpt6-pro-metadata.recorded.json", import.meta.url), "utf8"));
  for (const done of [false, true]) {
    const page = new FakePage();
    const receipts: any[] = [];
    const diagnostics: any[] = [];
    const observer = new ChatGptModelReceiptObserver("trace_recorded_abort", "chatgpt-web/gpt-6-pro", undefined, value => receipts.push(value), undefined, value => diagnostics.push(value));
    await observer.attach(page as never);
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const request = new FakeRequest(page, { model: "gpt-6-pro" });
    page.emit("request", request);
    page.cdp.emit("Network.requestWillBeSent", { requestId: "recorded", frameId: "main", request: { method: "POST", url: request.url(), postData: request.postData() } });
    page.cdp.emit("Network.responseReceived", { requestId: "recorded", response: { status: 200, headers: { "content-type": "text/event-stream" } } });
    const body = fixture.frames.map((frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
    page.cdp.emit("Network.dataReceived", { requestId: "recorded", data: Buffer.from(body).toString("base64") });
    page.cdp.emit("Network.loadingFailed", { requestId: "recorded" });
    await observer.flushCurrent();
    expect(receipts).toHaveLength(done ? 1 : 0);
    if (done) expect(receipts[0]).toMatchObject({ servedModel: "gpt-6-pro", source: "network.resolved_model_slug" });
    else expect(diagnostics[0]).toMatchObject({ outcome: "unavailable", reason: "stream_failed" });
    await observer.dispose();
  }
});

test("two DONE-terminated sources retain agreement checks after the recorded late abort", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/chatgpt-gpt6-pro-metadata.recorded.json", import.meta.url), "utf8"));
  for (const conflict of [false, true]) {
    const page = new FakeTeePage();
    const receipts: any[] = [];
    const diagnostics: any[] = [];
    const observer = new ChatGptModelReceiptObserver("trace_two_source_abort", "chatgpt-web/gpt-6-pro", undefined, value => receipts.push(value), undefined, value => diagnostics.push(value));
    await observer.attach(page as never);
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const request = new FakeRequest(page, { model: "gpt-6-pro" });
    page.emit("request", request);
    page.cdp.emit("Network.requestWillBeSent", { requestId: "paired", frameId: "main", request: { method: "POST", url: request.url(), postData: request.postData() } });
    page.cdp.emit("Network.responseReceived", { requestId: "paired", response: { status: 200, headers: { "content-type": "text/event-stream" } } });
    const body = fixture.frames.map((frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    page.cdp.emit("Network.dataReceived", { requestId: "paired", data: Buffer.from(body).toString("base64") });
    const token = (observer as unknown as { pageCaptureToken: string }).pageCaptureToken;
    expect(typeof token).toBe("string");
    expect(await observer.onPageCapture({ token, id: "paired-page", kind: "invoke" })).toBeTrue();
    expect(await observer.onPageCapture({ token, id: "paired-page", kind: "start", status: 200, contentType: "text/event-stream" })).toBeTrue();
    await observer.onPageCapture({ token, id: "paired-page", kind: "chunk", data: Buffer.from(conflict ? body.replaceAll("gpt-6-pro", "gpt-5-pro") : body).toString("base64") });
    await observer.onPageCapture({ token, id: "paired-page", kind: "failed" });
    page.cdp.emit("Network.loadingFailed", { requestId: "paired" });
    await observer.flushCurrent();
    expect(receipts).toHaveLength(conflict ? 0 : 1);
    if (conflict) expect(diagnostics[0].reason).toBe("conflicting_metadata");
    else expect(receipts[0].servedModel).toBe("gpt-6-pro");
    await observer.dispose();
  }
});

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

test("a hung CDP attach is bounded and a late session is detached without reactivating the observer", async () => {
  const cdp = new FakeCdp();
  let detachedResolve!: () => void;
  const detached = new Promise<void>(resolve => { detachedResolve = resolve; });
  cdp.detach = async () => { cdp.detached = true; detachedResolve(); };
  const page = new DelayedAttachPage(cdp);
  const observer = new ChatGptModelReceiptObserver("trace_attach_timeout", "chatgpt-web/gpt-6-pro", undefined);
  const started = Date.now();
  await observer.attach(page as never);
  expect(Date.now() - started).toBeLessThan(2_500);
  page.releaseSession();
  await detached;
  expect(cdp.detached).toBeTrue();
  await observer.dispose();
});

test("collector rejection is telemetry-only and does not reject the transport observer", async () => {
  const page = new FakePage();
  const diagnostics: any[] = [];
  const observer = new ChatGptModelReceiptObserver("trace_collector_failure", "chatgpt-web/gpt-6-pro", undefined, undefined, undefined, diagnostic => diagnostics.push(diagnostic));
  const original = ChatGptModelReceiptCollector.prototype.consumeSseChunk;
  ChatGptModelReceiptCollector.prototype.consumeSseChunk = () => { throw new Error("fixture decoder failure"); };
  try {
    await observer.attach(page as never);
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const request = new FakeRequest(page, { model: "gpt-6-pro" });
    emitOwnedNetwork(page, request, "collector-failure", resolvedSse("gpt-6-pro"));
    await observer.flushCurrent();
    expect(diagnostics).toMatchObject([{ outcome: "unavailable", reason: "stream_failed", failureStage: "data_received", failureCode: "collector_or_decoder_failed" }]);
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
