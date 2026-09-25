import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import * as lifecycle from "../src/adapters/chatgpt-web/browser-stage-lifecycle";

// Execute the shipped closure with the real stage/viewport lifecycle. Only CDP transport is fake.
function rebindFixture(viewport: "pending" | "failed" | "ready", connectMode: "normal" | "late" | "wrong-target" = "normal") {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = source.indexOf("      const rebindLauncherPage =");
  const end = source.indexOf("      const toolTurnObservationRecovery =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const closed: string[] = [];
  const old = { close: async () => { closed.push("old"); } };
  let connected!: () => void;
  const acquired = new Promise<void>(resolve => { connected = resolve; });
  let connectStarted!: () => void;
  const connecting = new Promise<void>(resolve => { connectStarted = resolve; });
  let releaseConnect!: () => void;
  const connectHeld = new Promise<void>(resolve => { releaseConnect = resolve; });
  let viewportReads = 0;
  const replacement = {
    browser: { close: async () => { closed.push("replacement"); } },
    descriptor: { surfaceTargets: { "same-surface": connectMode === "wrong-target" ? "other-target" : "original-target" } },
    page: { isClosed: () => false, evaluate: async () => {
      viewportReads++; connected();
      if (viewport === "failed") throw new Error("viewport unavailable");
      if (viewport === "pending") await new Promise(() => {});
      return { width: 800, height: 600 };
    } },
  };
  const dependencies = {
    ...lifecycle, old, deadline: undefined, launcherTargetId: "original-target",
    turn: { traceId: "rebind-ownership" }, launcherSurfaceId: "same-surface",
    process: { pid: 42 }, console: { warn() {} },
    redactChatGptUiDiagnostic: (text: string) => text,
    LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS: 100,
    browserStageTimeouts: { browserPage: 1_000 },
    notifyLauncherTurn: async () => {},
    connectLauncherBrowserHost: async (_descriptor: string, _budget: number, id: string) => {
      expect(id).toBe("same-surface");
      connectStarted();
      if (connectMode === "late") await connectHeld;
      return replacement;
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHostDescriptorPath: "offline-descriptor" },
  });
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    function factory() {
      let turnConnection = old;
      let page;
      let diagnosticPage;
      const submissionRejection = { noteRebind() {} };
      ${source.slice(start, end)}
      return { run: rebindLauncherPage, cleanup: async () => { await turnConnection?.close(); } };
    }
  `);
  const factory = new Function(...Object.keys(dependencies), `${body}; return factory;`)(...Object.values(dependencies));
  return { ...factory.call(worker) as {
    run(attempt: number, cause: Error, signal?: AbortSignal): Promise<void>;
    cleanup(): Promise<void>;
  }, closed, acquired, connecting, releaseConnect, viewportReads: () => viewportReads };
}

test("aborting rebind viewport preparation closes the unowned replacement connection", async () => {
  const fixture = rebindFixture("pending");
  const controller = new AbortController();
  const outcome = fixture.run(1, new Error("stalled read"), controller.signal).catch(error => error);
  await fixture.acquired;
  controller.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  await fixture.cleanup();
  // The stage abort may win its race before the action's failure cleanup settles.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.closed).toEqual(["old", "replacement"]);
});

test("failed viewport preparation closes replacement before propagating the error", async () => {
  const fixture = rebindFixture("failed");
  await expect(fixture.run(1, new Error("stalled read"))).rejects.toThrow("operational viewport");
  await fixture.cleanup();
  expect(fixture.closed).toEqual(["old", "replacement"]);
});

test("successful rebind transfers replacement ownership to terminal cleanup", async () => {
  const fixture = rebindFixture("ready");
  await fixture.run(1, new Error("stalled read"));
  expect(fixture.closed).toEqual(["old"]);
  await fixture.cleanup();
  expect(fixture.closed).toEqual(["old", "replacement"]);
});


test("a connect resolving after cancellation closes itself without adopting the late page", async () => {
  const fixture = rebindFixture("ready", "late");
  const controller = new AbortController();
  const reason = new DOMException("cancelled acquisition", "AbortError");
  const outcome = fixture.run(1, new Error("stalled read"), controller.signal).catch(error => error);
  await fixture.connecting;
  controller.abort(reason);
  fixture.releaseConnect();
  expect(await outcome).toBe(reason);
  await fixture.cleanup();
  expect(fixture.closed).toEqual(["old", "replacement"]);
  expect(fixture.viewportReads()).toBe(0);
});

test("a changed target mapping closes the replacement and never observes another owner", async () => {
  const fixture = rebindFixture("ready", "wrong-target");
  await expect(fixture.run(1, new Error("stalled read"))).rejects.toThrow("target ownership changed");
  await fixture.cleanup();
  expect(fixture.closed).toEqual(["old", "replacement"]);
  expect(fixture.viewportReads()).toBe(0);
});
