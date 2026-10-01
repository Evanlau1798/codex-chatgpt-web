import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron } from "playwright-core";
import { ChatGptModelReceiptObserver } from "../src/adapters/chatgpt-web/model-receipt";

const ELECTRON_PATH = join(import.meta.dir, "..", "launcher/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

test.skipIf(!existsSync(ELECTRON_PATH))("installed Electron CDP observer captures a loopback SSE without user state", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-model-receipt-electron-"));
  const profile = join(root, "profile");
  const main = join(root, "main.cjs");
  const largeFixture = "x".repeat(2_100_000);
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Electron fixture</title>");
      return;
    }
    if (request.method !== "POST" || request.url !== "/backend-api/f/conversation") {
      response.writeHead(404).end();
      return;
    }
    const requestChunks: Buffer[] = [];
    request.on("data", chunk => requestChunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const requestBody = Buffer.concat(requestChunks).toString("utf8");
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      if (requestBody.includes('"mode":"large"')) {
        response.end(largeFixture);
        return;
      }
      if (requestBody.includes('"mode":"bindingerror"')) {
        response.end(`data: ${JSON.stringify({
          conversation_id: "electron-binding-error-conversation",
          message: { id: "electron-binding-error-message", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } },
        })}\n\n`);
        return;
      }
      if (requestBody.includes('"mode":"midstream"')) {
        const splitPayload = Buffer.from(`data: ${JSON.stringify({
          conversation_id: "electron-conversation",
          message: { id: "electron-message-midstream", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" }, content: { parts: ["☃"] } },
        })}\n\n`);
        const snowmanOffset = splitPayload.indexOf(Buffer.from("☃"));
        response.write(splitPayload.subarray(0, snowmanOffset + 1));
        setTimeout(() => response.end(splitPayload.subarray(snowmanOffset + 1)), 250);
        return;
      }
      if (requestBody.includes('"mode":"preactivation"')) {
        setTimeout(() => response.end(`data: ${JSON.stringify({
          conversation_id: "electron-preactivation-conversation",
          message: { id: "electron-preactivation-message", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } },
        })}\n\n`), 250);
        return;
      }
      setTimeout(() => response.end(`data: ${JSON.stringify({
        conversation_id: "electron-conversation",
        message: { id: "electron-message", author: { role: "assistant" }, metadata: { resolved_model_slug: "gpt-6-pro" } },
      })}\n\n`), 100);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Electron fixture did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(main, `
    const { app, BrowserWindow } = require("electron");
    app.disableHardwareAcceleration();
    app.setPath("userData", process.env.RECEIPT_ELECTRON_PROFILE);
    app.whenReady().then(() => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
      window.loadURL(process.env.RECEIPT_ELECTRON_URL);
    });
  `);
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [main],
    env: { ...process.env, RECEIPT_ELECTRON_PROFILE: profile, RECEIPT_ELECTRON_URL: `${origin}/` },
  });
  const page = await app.firstWindow();
  const probe = await page.context().newCDPSession(page);
  await probe.send("Network.enable");
  const protocolEvents: string[] = [];
  let probeRequestId: string | undefined;
  let protocolError: Record<string, unknown> | undefined;
  probe.on("Network.requestWillBeSent", payload => {
    if (payload.request?.url?.endsWith("/backend-api/f/conversation")) {
      probeRequestId = payload.requestId;
      protocolEvents.push("requestWillBeSent");
    }
  });
  probe.on("Network.responseReceived", payload => {
    if (payload.requestId !== probeRequestId) return;
    protocolEvents.push("responseReceived");
    void probe.send("Network.streamResourceContent", { requestId: payload.requestId }).catch(error => {
      protocolError = {
        name: error instanceof Error ? error.name : "unknown",
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
        messageClass: error instanceof Error ? error.message.replace(/[^A-Za-z0-9 _-]/g, " ").slice(0, 160) : "unknown",
      };
    });
  });
  probe.on("Network.dataReceived", payload => {
    if (payload.requestId === probeRequestId) protocolEvents.push("dataReceived");
  });
  probe.on("Network.loadingFinished", payload => {
    if (payload.requestId === probeRequestId) protocolEvents.push("loadingFinished");
  });
  const runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  }));
  const diagnostics: Array<Record<string, unknown>> = [];
  const receipts: Array<Record<string, unknown>> = [];
  const observer = new ChatGptModelReceiptObserver(
    "electron-receipt-trace",
    "chatgpt-web/gpt-6-pro",
    "gpt-5.6-sol",
    receipt => receipts.push(receipt as unknown as Record<string, unknown>),
    `${origin}/backend-api/f/conversation`,
    diagnostic => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
  );
  let rebound: ChatGptModelReceiptObserver | undefined;
  let stalled: ChatGptModelReceiptObserver | undefined;
  let splitObserver: ChatGptModelReceiptObserver | undefined;
  let midstream: ChatGptModelReceiptObserver | undefined;
  let preactivation: ChatGptModelReceiptObserver | undefined;
  let bindingErrorObserver: ChatGptModelReceiptObserver | undefined;
  try {
    await observer.attach(page);
    await page.goto(`${origin}/?temporary-chat=true`, { waitUntil: "domcontentloaded" });
    await observer.ensurePageCaptureReady();
    observer.beginSend({ responseAttempt: 1 });
    observer.activate();
    const result = await page.evaluate(async endpoint => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-pro" }),
      });
      return { status: response.status, body: await response.text() };
    }, `${origin}/backend-api/f/conversation`);
    await observer.flushCurrent();
    await observer.dispose();
    expect(runtime.electron).toBe("41.10.7");
    expect(typeof runtime.chromium).toBe("string");
    expect(result.status).toBe(200);
    expect(result.body).toContain("resolved_model_slug");
    expect(diagnostics).toHaveLength(1);
    expect(receipts.length).toBeLessThanOrEqual(1);
    if (diagnostics[0]!.outcome === "resolved") {
      expect(receipts).toHaveLength(1);
      // Electron 41 / Chromium 146 rejects streamResourceContent after this
      // loopback response has finished; the page-local tee is the observed
      // second terminal source, not a mocked CDP verdict.
      expect(diagnostics[0]!.cdpCaptures).toBe(1);
      expect(diagnostics[0]!.terminalCaptures).toBe(2);
      expect(diagnostics[0]!.failureCode).toBe("stream_resource_content_rejected");
      expect(protocolError).toBeDefined();
      expect(diagnostics[0]!.page).toMatchObject({
        installed: true,
        rebindPending: false,
        invocations: 1,
        starts: 1,
        terminals: 1,
        rejected: 0,
      });
      expect((diagnostics[0]!.page as { rebinds: number }).rebinds).toBeGreaterThan(0);
    } else expect(receipts).toHaveLength(0);
    expect(JSON.stringify(diagnostics)).not.toContain("authorization");
    expect(JSON.stringify(diagnostics)).not.toContain("cookie");

    // A later application wrapper must survive our identity-checked uninstall.
    // Reattaching on the same Page then wraps that later wrapper and restores it
    // again, instead of replacing or retaining the old observer's wrapper.
    await page.evaluate(() => {
      const previous = window.fetch;
      (window as typeof window & { __laterFetchCalls?: number }).__laterFetchCalls = 0;
      window.fetch = (async (...args: Parameters<typeof window.fetch>) => {
        const root = window as typeof window & { __laterFetchCalls?: number };
        root.__laterFetchCalls = (root.__laterFetchCalls ?? 0) + 1;
        return previous(...args);
      }) as typeof window.fetch;
    });
    const laterFetch = await page.evaluate(async endpoint => {
      const response = await fetch(endpoint, { method: "POST", body: "{}" });
      return { status: response.status, body: await response.text(), calls: (window as typeof window & { __laterFetchCalls?: number }).__laterFetchCalls };
    }, `${origin}/backend-api/f/conversation`);
    expect(laterFetch.status).toBe(200);
    expect(laterFetch.calls).toBe(1);

    const reboundDiagnostics: Array<Record<string, unknown>> = [];
    const reboundReceipts: Array<Record<string, unknown>> = [];
    rebound = new ChatGptModelReceiptObserver(
      "electron-rebound-trace",
      "chatgpt-web/gpt-6-pro",
      "gpt-5.6-sol",
      receipt => reboundReceipts.push(receipt as unknown as Record<string, unknown>),
      `${origin}/backend-api/f/conversation`,
      diagnostic => reboundDiagnostics.push(diagnostic as unknown as Record<string, unknown>),
    );
    await rebound.attach(page);
    rebound.beginSend({ responseAttempt: 1 });
    rebound.activate();
    const reboundFetch = await page.evaluate(async endpoint => {
      const request = new Request(endpoint, { method: "GET" });
      const response = await fetch(request, { method: "POST", body: "{}" });
      return { status: response.status, body: await response.text(), calls: (window as typeof window & { __laterFetchCalls?: number }).__laterFetchCalls };
    }, `${origin}/backend-api/f/conversation`);
    await rebound.flushCurrent();
    await rebound.dispose();
    expect(reboundFetch.status).toBe(200);
    expect(reboundFetch.calls).toBe(2);
    expect(reboundDiagnostics).toHaveLength(1);
    expect(reboundReceipts).toHaveLength(1);
    await rebound.dispose().catch(() => {});

    // Stall the Node binding after the browser has received headers.  The
    // page-local clone must cancel at its byte bound while the original fetch
    // still returns the complete loopback body.
    let releaseBinding!: () => void;
    let bindingStarted!: () => void;
    const bindingGate = new Promise<void>(resolve => { releaseBinding = resolve; });
    const bindingSeen = new Promise<void>(resolve => { bindingStarted = resolve; });
    const stalledDiagnostics: Array<Record<string, unknown>> = [];
    stalled = new ChatGptModelReceiptObserver(
      "electron-stalled-trace",
      "chatgpt-web/gpt-6-pro",
      "gpt-5.6-sol",
      undefined,
      `${origin}/backend-api/f/conversation`,
      diagnostic => stalledDiagnostics.push(diagnostic as unknown as Record<string, unknown>),
    );
    const originalPageCapture = stalled.onPageCapture;
    (stalled as unknown as { onPageCapture: typeof stalled.onPageCapture }).onPageCapture = async value => {
      if ((value as { kind?: unknown })?.kind === "start") {
        bindingStarted();
        await bindingGate;
      }
      return originalPageCapture(value);
    };
    await page.evaluate(() => {
      const root = window as typeof window & { __receiptCloneCancelled?: boolean };
      root.__receiptCloneCancelled = false;
      const previousClone = Response.prototype.clone;
      Response.prototype.clone = function(this: Response) {
        const clone = previousClone.call(this);
        const body = clone.body;
        if (!body) return clone;
        return new Proxy(clone, {
          get(target, property, receiver) {
            if (property === "body") {
              return {
                getReader() {
                  const reader = body.getReader();
                  return new Proxy(reader, {
                    get(readerTarget, readerProperty, readerReceiver) {
                      if (readerProperty === "cancel") {
                        return (...args: unknown[]) => {
                          root.__receiptCloneCancelled = true;
                          return reader.cancel(...args);
                        };
                      }
                      const value = Reflect.get(readerTarget, readerProperty, readerTarget);
                      return typeof value === "function" ? value.bind(readerTarget) : value;
                    },
                  });
                },
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
      };
    });
    await stalled.attach(page);
    stalled.beginSend({ responseAttempt: 1 });
    stalled.activate();
    const largeFetchPromise = page.evaluate(async endpoint => {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ mode: "large" }) });
      const body = await response.text();
      return { status: response.status, bodyLength: body.length };
    }, `${origin}/backend-api/f/conversation`);
    await bindingSeen;
    const largeFetch = await largeFetchPromise;
    expect(largeFetch.status).toBe(200);
    expect(largeFetch.bodyLength).toBe(largeFixture.length);
    expect(await page.evaluate(() => (window as typeof window & { __receiptCloneCancelled?: boolean }).__receiptCloneCancelled)).toBe(true);
    releaseBinding();
    await stalled.dispose();
    expect(stalledDiagnostics.length).toBeLessThanOrEqual(1);

    // A rejected Node binding while delivering a chunk must cancel only the
    // observation reader; the original response still resolves in full.
    const bindingErrorDiagnostics: Array<Record<string, unknown>> = [];
    const bindingErrorReceipts: Array<Record<string, unknown>> = [];
    bindingErrorObserver = new ChatGptModelReceiptObserver(
      "electron-binding-error-trace",
      "chatgpt-web/gpt-6-pro",
      "gpt-5.6-sol",
      receipt => bindingErrorReceipts.push(receipt as unknown as Record<string, unknown>),
      `${origin}/backend-api/f/conversation`,
      diagnostic => bindingErrorDiagnostics.push(diagnostic as unknown as Record<string, unknown>),
    );
    const originalBindingErrorCapture = bindingErrorObserver.onPageCapture;
    (bindingErrorObserver as unknown as { onPageCapture: typeof bindingErrorObserver.onPageCapture }).onPageCapture = async value => {
      if ((value as { kind?: unknown })?.kind === "chunk") throw new Error("fixture binding rejection");
      return originalBindingErrorCapture(value);
    };
    await page.evaluate(() => { (window as typeof window & { __receiptCloneCancelled?: boolean }).__receiptCloneCancelled = false; });
    await bindingErrorObserver.attach(page);
    bindingErrorObserver.beginSend({ responseAttempt: 1 });
    bindingErrorObserver.activate();
    const bindingErrorFetch = await page.evaluate(async endpoint => {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ mode: "bindingerror" }) });
      const body = await response.text();
      return { status: response.status, bodyLength: body.length };
    }, `${origin}/backend-api/f/conversation`);
    await bindingErrorObserver.flushCurrent();
    await bindingErrorObserver.dispose();
    expect(bindingErrorFetch.status).toBe(200);
    expect(bindingErrorFetch.bodyLength).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as typeof window & { __receiptCloneCancelled?: boolean }).__receiptCloneCancelled)).toBe(true);
    expect(bindingErrorReceipts).toHaveLength(0);
    expect(bindingErrorDiagnostics).toHaveLength(1);

    // The same page-local source must preserve a UTF-8 code point split across
    // transport chunks and still resolve authoritative metadata.
    const splitDiagnostics: Array<Record<string, unknown>> = [];
    const splitReceipts: Array<Record<string, unknown>> = [];
    splitObserver = new ChatGptModelReceiptObserver(
      "electron-split-trace",
      "chatgpt-web/gpt-6-pro",
      "gpt-5.6-sol",
      receipt => splitReceipts.push(receipt as unknown as Record<string, unknown>),
      `${origin}/backend-api/f/conversation`,
      diagnostic => splitDiagnostics.push(diagnostic as unknown as Record<string, unknown>),
    );
    await splitObserver.attach(page);
    splitObserver.beginSend({ responseAttempt: 1 });
    splitObserver.activate();
    const splitFetch = await page.evaluate(async endpoint => {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ mode: "midstream" }) });
      return { status: response.status, body: await response.text() };
    }, `${origin}/backend-api/f/conversation`);
    await splitObserver.flushCurrent();
    await splitObserver.dispose();
    expect(splitFetch.status).toBe(200);
    expect(splitFetch.body).toContain("☃");
    expect(splitDiagnostics).toHaveLength(1);
    expect(splitReceipts).toHaveLength(1);

    // Detaching during an active response must remove only observation hooks;
    // the browser's original fetch and its split UTF-8 body still complete.
    midstream = new ChatGptModelReceiptObserver(
      "electron-midstream-trace",
      "chatgpt-web/gpt-6-pro",
      "gpt-5.6-sol",
      undefined,
      `${origin}/backend-api/f/conversation`,
    );
    await midstream.attach(page);
    midstream.beginSend({ responseAttempt: 1 });
    midstream.activate();
    const midstreamFetchPromise = page.evaluate(async endpoint => {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ mode: "midstream" }) });
      (window as typeof window & { __midstreamHeaders?: boolean }).__midstreamHeaders = true;
      return { status: response.status, body: await response.text() };
    }, `${origin}/backend-api/f/conversation`);
    await page.waitForFunction(() => Boolean((window as typeof window & { __midstreamHeaders?: boolean }).__midstreamHeaders));
    await midstream.detach();
    const midstreamFetch = await midstreamFetchPromise;
    expect(midstreamFetch.status).toBe(200);
    expect(midstreamFetch.body).toContain("☃");
    await midstream.dispose();

    // A fetch invoked before activation must not become owned merely because
    // its response headers/body arrive after the next Send is activated.
    const preactivationDiagnostics: Array<Record<string, unknown>> = [];
    const preactivationReceipts: Array<Record<string, unknown>> = [];
    preactivation = new ChatGptModelReceiptObserver(
      "electron-preactivation-trace",
      "chatgpt-web/gpt-6-pro",
      "gpt-5.6-sol",
      receipt => preactivationReceipts.push(receipt as unknown as Record<string, unknown>),
      `${origin}/backend-api/f/conversation`,
      diagnostic => preactivationDiagnostics.push(diagnostic as unknown as Record<string, unknown>),
    );
    await preactivation.attach(page);
    const preactivationEndpoint = `${origin}/backend-api/f/conversation`;
    const staleRequest = page.waitForRequest(request => request.url() === preactivationEndpoint && request.method() === "POST");
    const preactivationFetch = page.evaluate(async endpoint => {
      const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ mode: "preactivation" }) });
      return { status: response.status, body: await response.text() };
    }, preactivationEndpoint);
    await staleRequest;
    preactivation.beginSend({ responseAttempt: 1 });
    preactivation.activate();
    const staleResult = await preactivationFetch;
    await preactivation.flushCurrent();
    await preactivation.dispose();
    expect(staleResult.status).toBe(200);
    expect(staleResult.body).toContain("electron-preactivation-message");
    expect(preactivationReceipts).toHaveLength(0);
    expect(preactivationDiagnostics).toMatchObject([{ outcome: "unavailable", reason: "no_owned_request" }]);
    await Bun.sleep(25);
    console.info(`[offline-electron-receipt] ${JSON.stringify({ runtime, diagnostic: diagnostics[0], receiptCount: receipts.length, protocolEvents, protocolError })}`);
  } finally {
    await observer.dispose().catch(() => {});
    await rebound?.dispose().catch(() => {});
    await stalled?.dispose().catch(() => {});
    await splitObserver?.dispose().catch(() => {});
    await midstream?.dispose().catch(() => {});
    await preactivation?.dispose().catch(() => {});
    await bindingErrorObserver?.dispose().catch(() => {});
    await probe.detach().catch(() => {});
    await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
