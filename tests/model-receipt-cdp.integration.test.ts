import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { ChatGptModelReceiptObserver } from "../src/adapters/chatgpt-web/model-receipt";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function fixtureOperationDrain(page: unknown): () => Promise<void> {
  const pending = new Set<Promise<unknown>>();
  const target = page as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ["evaluate", "exposeBinding"]) {
    const invoke = target[name]!.bind(page);
    target[name] = (...args) => {
      const operation = invoke(...args);
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
  }
  // Production telemetry stays bounded. The disposable fixture owns the
  // browser and must await its outstanding real protocol operations before
  // destroying Page, rather than racing late Playwright channel creation.
  return async () => { while (pending.size) await Promise.allSettled([...pending]); };
}
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/model-receipt-cdp-golden.json", import.meta.url), "utf8")) as {
  requiredEvents: string[];
  resolvedModelSlug: string;
  assistantMessageId: string;
  conversationId: string;
};

test.skipIf(!existsSync(CHROME_PATH))("real Chromium CDP transport captures headerless delayed SSE", async () => {
  const startedAt = Date.now();
  const phases: Array<{ phase: string; elapsedMs: number }> = [];
  const mark = (phase: string) => phases.push({ phase, elapsedMs: Date.now() - startedAt });
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>offline transport fixture</title>");
      return;
    }
    if (request.method !== "POST" || request.url !== "/backend-api/f/conversation") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    mark("request_received");
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const frame = `data: ${JSON.stringify({
      conversation_id: FIXTURE.conversationId,
      message: {
        id: FIXTURE.assistantMessageId,
        author: { role: "assistant" },
        metadata: { resolved_model_slug: FIXTURE.resolvedModelSlug },
      },
    })}\n\n`;
    setTimeout(() => {
      mark("first_chunk");
      response.write(frame.slice(0, Math.floor(frame.length / 2)));
      // The provider fixture must finish independently of telemetry readiness.
      // Otherwise a legitimate best-effort attach refusal deadlocks this test.
      setTimeout(() => {
        response.write(frame.slice(Math.floor(frame.length / 2)));
        response.end();
      }, 250);
    }, 2_100);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("offline fixture did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = mkdtempSync(join(tmpdir(), "model-receipt-cdp-profile-"));
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  mark("browser_started");
  const page = await browser.newPage();
  const drainFixture = fixtureOperationDrain(page);
  const probe = await page.context().newCDPSession(page);
  await probe.send("Network.enable");
  const events = new Set<string>();
  let streamCommandResolved = false;
  let streamCommands = 0;
  let streamCommand: Promise<void> = Promise.resolve();
  // Observe the production observer's real streaming command. A second probe
  // issuing streamResourceContent mutates the same response and can race the
  // observer; the out-of-band probe below must remain passive.
  const context = page.context();
  const createSession = context.newCDPSession.bind(context);
  const sessionFactory = spyOn(context, "newCDPSession").mockImplementation(async target => {
    const session = await createSession(target);
    const send = session.send.bind(session);
    (session as any).send = (method: string, params: unknown) => {
      const pending = (send as any)(method, params);
      if (method === "Network.streamResourceContent") {
        mark("observer_stream_enable_started");
        streamCommands++;
        streamCommand = pending.then(() => { mark("observer_stream_enable_completed"); streamCommandResolved = true; }, () => { mark("observer_stream_enable_failed"); });
      }
      return pending;
    };
    return session;
  });
  probe.on("Network.requestWillBeSent", () => events.add("Network.requestWillBeSent"));
  probe.on("Network.responseReceived", payload => {
    if (payload.response.url !== `${origin}/backend-api/f/conversation`) return;
    events.add("Network.responseReceived");
  });
  probe.on("Network.dataReceived", payload => {
    events.add("Network.dataReceived");
    void payload;
  });
  probe.on("Network.loadingFinished", () => events.add("Network.loadingFinished"));
  const receipts: Array<Record<string, unknown>> = [];
  const diagnostics: unknown[] = [];
  const observer = new ChatGptModelReceiptObserver(
    "trace_real_cdp",
    "chatgpt-web/gpt-6-pro",
    undefined,
    receipt => receipts.push(receipt as unknown as Record<string, unknown>),
    `${origin}/backend-api/f/conversation`,
    diagnostic => diagnostics.push(diagnostic),
  );
  try {
    await page.goto(`${origin}/`);
    await observer.attach(page);
    mark("observer_attached");
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const result = await page.evaluate(async endpoint => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-pro", conversation_id: "conversation-fixture" }),
      });
      return { status: response.status, body: await response.text() };
    }, `${origin}/backend-api/f/conversation`);
    await streamCommand;
    mark("browser_body_complete");
    await observer.flushCurrent();
    await observer.dispose();
    expect(result.status).toBe(200);
    expect(result.body).toContain("resolved_model_slug");
    expect(streamCommandResolved).toBeTrue();
    expect(streamCommands).toBe(1);
    for (const event of FIXTURE.requiredEvents) expect(events.has(event)).toBeTrue();
    if (receipts.length !== 1) console.info("[offline-cdp-receipt-failure]", JSON.stringify({ phases, diagnostics }));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      servedModel: FIXTURE.resolvedModelSlug,
      source: "network.resolved_model_slug",
      responseAttempt: 1,
    });
    expect(receipts[0]).toHaveProperty("messageIdHash");
    expect(receipts[0]).not.toHaveProperty("messageId", FIXTURE.assistantMessageId);
  } finally {
    sessionFactory.mockRestore();
    await observer.dispose().catch(() => {});
    await probe.detach().catch(() => {});
    await drainFixture();
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(profile, { recursive: true, force: true });
  }
// Chrome's own startup/navigation budget is 30s. The outer test must leave
// room for that plus this deliberately delayed stream and awaited teardown.
}, 60_000);

test.skipIf(!existsSync(CHROME_PATH))("mid-stream observer detach does not cancel the browser fetch", async () => {
  let releaseTail!: () => void;
  let markStarted!: () => void;
  const tailGate = new Promise<void>(resolve => { releaseTail = resolve; });
  const responseStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>detach fixture</title>");
      return;
    }
    if (request.method !== "POST" || request.url !== "/backend-api/f/conversation") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const frame = `data: ${JSON.stringify({
      conversation_id: "conversation-detach",
      message: { id: "message-detach", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } },
    })}\n\n`;
    response.write(frame.slice(0, Math.floor(frame.length / 2)));
    markStarted();
    void tailGate.then(() => {
      response.write(frame.slice(Math.floor(frame.length / 2)));
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("offline detach fixture did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = mkdtempSync(join(tmpdir(), "model-receipt-cdp-detach-"));
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = await browser.newPage();
  const drainFixture = fixtureOperationDrain(page);
  const observer = new ChatGptModelReceiptObserver(
    "trace_midstream_detach",
    "chatgpt-web/gpt-6-pro",
    undefined,
    undefined,
    `${origin}/backend-api/f/conversation`,
  );
  try {
    await page.goto(`${origin}/`);
    await observer.attach(page);
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const fetchPromise = page.evaluate(async endpoint => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-pro" }),
      });
      return { status: response.status, body: await response.text() };
    }, `${origin}/backend-api/f/conversation`);
    await responseStarted;
    await observer.dispose();
    releaseTail();
    const result = await fetchPromise;
    expect(result.status).toBe(200);
    expect(result.body).toContain("resolved_model_slug");
  } finally {
    await observer.dispose().catch(() => {});
    releaseTail();
    await drainFixture();
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(profile, { recursive: true, force: true });
  }
}, 60_000);
