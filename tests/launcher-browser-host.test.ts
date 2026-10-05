import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  LauncherBrowserTurnCancelledError,
  inspectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation,
  selectLauncherPage,
  verifyLauncherBrowserConnector,
} from "../src/launcher-browser-host";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptStartupPagePool } from "../src/adapters/chatgpt-web/startup-page-pool";

const roots: string[] = [];

test("claimed startup cleanup failure still settles the newly acquired real turn", async () => {
  const events: Array<{ phase: string; traceId: string }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { phase: string; traceId: string };
    events.push(body);
    return Response.json(body.phase === "start"
      ? { surfaceId: "a".repeat(32), reused: false, connectorBound: true, startupPrepared: true }
      : { cancelledByUser: false, authenticationRequired: false });
  } });
  const prior = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  const pool = new ChatGptStartupPagePool<any>();
  let acknowledged = false;
  try {
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptorFile(`http://127.0.0.1:${server.port}`) },
      startupPages: pool,
      runBrowserTurn: async () => { throw new Error("must not run after failed cleanup"); },
    });
    const turn = { traceId: "claim-cleanup", modelId: "gpt-5.6-sol", reasoning: "high",
      modelFamily: "5.6", nativeConnector: true, allowStartupPreparation: true,
      capabilities: { localToolsEnabled: true, solAvailable: true } };
    await pool.prime(worker.startupPageKey(turn), "Harness", async () => ({ surfaceId: "a".repeat(32),
      prefix: "Harness", pauseHeartbeat() {}, release: async () => { if (!acknowledged) throw new Error("startup cleanup failed"); } }));
    await expect(worker.runExclusive(turn)).rejects.toThrow("startup cleanup failed");
    expect(events.filter(e => e.phase === "end" && e.traceId === "claim-cleanup")).toHaveLength(1);
    await expect(pool.cancel()).rejects.toThrow("startup cleanup failed");
    acknowledged = true; await pool.cancel();
  } finally {
    acknowledged = true; await pool.cancel();
    if (prior === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = prior;
    server.stop(true);
  }
});

test("launcher activity follows actual send callbacks and current-turn tool counts", async () => {
  const messages: Array<{ phase: string; progress?: { stage: string; activeToolCalls: number } }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const message = await request.json() as typeof messages[number];
    messages.push(message);
    return Response.json(message.phase === "start"
      ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
      : { cancelledByUser: false });
  } });
  const waitForStage = async (stage: string) => {
    const deadline = Date.now() + 1_000;
    while (!messages.some(message => message.progress?.stage === stage) && Date.now() < deadline) await Bun.sleep(5);
    expect(messages.some(message => message.progress?.stage === stage)).toBeTrue();
  };
  let activeToolCalls = 0;
  let activated = 0;
  let submitted = 0;
  try {
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptorFile(`http://127.0.0.1:${server.port}`) },
      runBrowserTurn: async (turn: { onSendActivated(): Promise<void>; onSubmitted(): Promise<void> }) => {
        await waitForStage("preparing");
        await turn.onSendActivated();
        await waitForStage("sending");
        activeToolCalls = 2;
        await turn.onSubmitted();
        await waitForStage("chatgpt");
        return "done";
      },
    });
    await expect(worker.runExclusive({
      traceId: "activity-fixture", modelId: "gpt-5.6-sol", reasoning: "high", modelFamily: "5.6",
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      externalProgress: { snapshot: () => ({ activeToolCalls }) },
      onSendActivated: () => { activated++; }, onSubmitted: () => { submitted++; },
    })).resolves.toBe("done");
    expect(messages.filter(message => message.progress).map(message => message.progress)).toEqual([
      { stage: "preparing", activeToolCalls: 0 }, { stage: "sending", activeToolCalls: 0 },
      { stage: "chatgpt", activeToolCalls: 2 },
    ]);
    expect(messages.at(-1)?.phase).toBe("end");
    expect([activated, submitted]).toEqual([1, 1]);
  } finally { server.stop(true); }
});

test("a blocked sign-in replaces an opaque navigation abort with a non-retryable session error", async () => {
  let needsSignIn: unknown = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const activity = await req.json() as { phase: string };
    return Response.json(activity.phase === "start"
      ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
      : { cancelledByUser: false, authenticationRequired: needsSignIn });
  } });
  try {
    const descriptor = descriptorFile(`http://127.0.0.1:${server.port}`);
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptor },
      runBrowserTurn: async () => { throw new Error("page.goto: net::ERR_ABORTED"); },
    });
    const turn = {
      traceId: "auth-redirect",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true },
    };
    await expect(worker.runExclusive(turn)).rejects.toMatchObject({
      status: 401, code: "chatgpt_sign_in_required", retryable: false,
    });
    needsSignIn = false;
    await expect(worker.runExclusive(turn)).rejects.toThrow("page.goto: net::ERR_ABORTED");
    needsSignIn = "true";
    await expect(notifyLauncherTurn(descriptor, { phase: "end", traceId: "auth-redirect", helperPid: process.pid, status: "failed" }))
      .rejects.toThrow("invalid authentication state");
  } finally { server.stop(true); }
});

test("startup waits beyond five seconds and distinguishes its deadline from caller cancellation", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    calls++;
    await Bun.sleep(calls === 1 ? 5_100 : 80);
    return Response.json({ surfaceId: "a".repeat(32), reused: false, connectorBound: false });
  } });
  try {
    const descriptor = descriptorFile(`http://127.0.0.1:${server.port}`);
    const activity = { phase: "start" as const, traceId: "bounded-start", helperPid: process.pid };
    await expect(notifyLauncherTurn(descriptor, activity)).resolves.toMatchObject({ reused: false });
    await expect(notifyLauncherTurn(descriptor, activity, 10)).rejects.toThrow("start timed out after 10ms");
    const controller = new AbortController();
    const pending = notifyLauncherTurn(descriptor, activity, undefined, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(3);
  } finally { server.stop(true); }
}, 10_000);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  controlEndpoint = "http://127.0.0.1:39111",
  profile: "production" | "development" = "production",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: profile === "development"
      ? "persist:codex-web-gpt-dev-chatgpt"
      : "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? '{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":true,"connectorBound":true}\n'
      : request.url === "/v1/turn/end"
        ? '{"ok":true,"cancelledByUser":false}\n'
        : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    })).resolves.toEqual({
      surfaceId: "launcher_surface_id_0123456789AB",
      reused: true,
      connectorBound: true,
      trackUsage: false,
    });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({ phase: "start", traceId: "abc123def456", helperPid: process.pid,
      conversationKey: "a".repeat(64), connectorIdentity: "Codex Native2", requireRetainedConversation: true });
    await notifyLauncherTurn(path, {
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
    });
    expect(received.body).toEqual({ phase: "heartbeat", traceId: "abc123def456", helperPid: process.pid });
    await expect(notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
    })).resolves.toEqual({ cancelledByUser: false });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher release validates the owned authentication flag without coercion", async () => {
  let authenticationRequired: unknown = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ ok: true, cancelledByUser: false, authenticationRequired }),
  });
  try {
    const path = descriptorFile(`http://127.0.0.1:${server.port}`);
    const end = () => notifyLauncherTurn(path, {
      phase: "end", traceId: "auth_test_trace", helperPid: process.pid, status: "failed",
    });
    await expect(end()).resolves.toEqual({ cancelledByUser: false, authenticationRequired: true });
    authenticationRequired = "true";
    await expect(end()).rejects.toThrow("invalid authentication state");
    authenticationRequired = false;
    await expect(end()).resolves.toEqual({ cancelledByUser: false });
  } finally { await server.stop(true); }
});

test("launcher retained-conversation release uses its authenticated lifecycle endpoint", async () => {
  let received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"released":1}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(releaseLauncherRetainedConversation(path, "a".repeat(64))).resolves.toBe(1);
    expect(received).toEqual({
      url: "/v1/turn/release",
      authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      body: { conversationKey: "a".repeat(64) },
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves explicit user cancellation as a terminal signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"turn closed by user","code":"turn_cancelled"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "cancelled123",
      helperPid: process.pid,
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(LauncherBrowserTurnCancelledError);
    expect((error as Error).message).toBe("turn closed by user");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectCapabilities: true })).toEqual({
      authenticated: true,
      temporary: true,
      composer: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher connector verification uses the authenticated existing browser operation", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/verify-connector");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({});
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"verified":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(verifyLauncherBrowserConnector(path)).resolves.toBeTrue();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification reports its own deadline instead of a generic abort", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    if (!response.destroyed) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"late"}\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(inspectLauncherBrowserHost(path, { detectCapabilities: true, timeoutMs: 5 }))
      .rejects.toThrow("session inspection timed out after 5ms");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.endpoint = "https://example.com:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("http://127.0.0.1");
});

test("launcher profile checks reject cross-profile browser ownership", async () => {
  const path = descriptorFile("http://127.0.0.1:39111", "development");
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt",
  });
  await expect(inspectLauncherBrowserHost(path, { expectedProfile: "production", timeoutMs: 5 }))
    .rejects.toThrow("belongs to development");
});

function nativeTargetContext(pages: Page[], targetId: (page: Page) => string): BrowserContext {
  return {
    pages: () => pages,
    newCDPSession: async (page: Page) => ({
      send: async (method: string) => {
        expect(method).toBe("Target.getTargetInfo");
        return { targetInfo: { targetId: targetId(page) } };
      },
      detach: async () => {},
    }),
  } as unknown as BrowserContext;
}

test("launcher page selection uses native ownership without evaluating unrelated renderers", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: () => { throw new Error("Do not evaluate an unrelated renderer"); },
  } as unknown as Page;
  const ownedPage = {
    url: () => LAUNCHER_BROWSER_IDLE_URL,
    evaluate: () => { throw new Error("Ownership comes from the native target"); },
  } as unknown as Page;
  const context = nativeTargetContext([hiddenPage, ownedPage],
    page => page === ownedPage ? "native-owned-target" : "native-other-target");
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({
    context,
    page: ownedPage,
  });
});

test("launcher page selection rejects duplicated native target ownership", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({
    evaluate: async () => descriptor.surfaceId,
  }) as unknown as Page;
  const context = nativeTargetContext([page(), page()], () => "native-owned-target");
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same ownership id",
  );
});

test("launcher descriptor rejects ambiguous native targets and selection rejects retired surfaces", async () => {
  const path = descriptorFile();
  const descriptor = readLauncherBrowserHostDescriptor(path);
  const duplicate = { ...descriptor, surfaceTargets: {
    ...descriptor.surfaceTargets, ["x".repeat(32)]: "native-owned-target",
  } };
  writeFileSync(path, JSON.stringify(duplicate), { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("duplicated surface targets");
  const browser = { contexts: () => [] } as unknown as Browser;
  await expect(selectLauncherPage(browser, descriptor, 20, "retired".repeat(5))).rejects.toThrow("no longer registered");
  writeFileSync(path, JSON.stringify({ ...descriptor, version: 2 }), { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("restart the updated launcher");
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});
