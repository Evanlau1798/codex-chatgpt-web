import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRequire } from "node:module";
import http from "node:http";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
const { RuntimeSupervisor } = createRequire(import.meta.url)("../launcher/electron/runtime-supervisor.cjs");

test("mode switch refuses the delayed-body browser race and resumes admission", async () => {
const config = { ...defaultConfig("browser-only"), port: 0 };
let entered!: () => void;
const ready = new Promise<void>(resolve => { entered = resolve; });
let cancelled = 0;
const server = startServer(config, {
  adapterFactory: () => ({ name: "delayed-body-fixture",
    runTurn: async () => {
      let finish!: (answer: string) => void;
      const browser = new Promise<string>(resolve => { finish = resolve; });
      chatGptTurnSessions.getOrCreate("review-drain-race", () => ({
        mode: "read-only", browser,
        trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
        cancel: () => { cancelled++; finish("cancelled"); },
      }));
      entered();
      await browser;
    },
  }),
});
config.port = server.port!;
const endpoint = `http://127.0.0.1:${server.port}`;
const request = http.request(`${endpoint}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer fixture-session" },
});
request.on("error", () => {});
request.on("response", response => response.resume());
request.write("{"); // Accepted HTTP request, still awaiting the rest of its JSON body.

const supervisor = new RuntimeSupervisor({
  app: { getPath: () => process.cwd(), getVersion: () => "5.0.0" },
  sourceRoot: process.cwd(), coreHome: process.cwd(),
  logger: { info() {}, warn() {}, error() {} },
});
supervisor.readConfig = () => config;
supervisor.readState = () => null;
supervisor.proxyHealth = async () => true;
supervisor.daemon = { pid: process.pid, exitCode: null, signalCode: null };
// Listener is in-process: do not wait for/terminate this process. HTTP controls are real.
supervisor.waitForChildExit = async () => {};
supervisor.clearState = () => {};
supervisor.tryWriteState = () => {};
supervisor.ownedRuntimeReady = async () => false;
const originalControl = supervisor.control.bind(supervisor);
const controls: string[] = [];
let drainSnapshot!: { active_browser_turns: number };
supervisor.control = async (current: typeof config, action: string, ...rest: unknown[]) => {
  controls.push(action);
  const reply = await originalControl(current, action, ...rest);
  if (action === "drain") {
    drainSnapshot = reply;
    request.end('"model":"chatgpt-web/medium","input":"fixture"}');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("adapter not entered")), 1500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(chatGptTurnSessions.activeCount(), 1);
  }
  return reply;
};

try {
  let admitted = false;
  for (let n = 0; n < 100; n++) {
    const health = await (await fetch(`${endpoint}/healthz`)).json();
    if (health.active_http_turns === 1) { admitted = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(admitted, true, "fixture HTTP body must be pending before drain");
  let stopError;
  try {
    await supervisor.stopForSetup({ browserOnly: true });
  } catch (error) {
    stopError = error instanceof Error ? error.message : String(error);
  }
  const modeStopSucceeded = supervisor.daemon === null;
  const health = modeStopSucceeded ? undefined : await (await fetch(`${endpoint}/healthz`)).json();
  // RED on the old unguarded route; GREEN only when the source survives and admission resumes.
  assert.equal(drainSnapshot.active_browser_turns, 0);
  assert.equal(cancelled, 0, "mode switch must not cancel the newly active browser source");
  assert.equal(modeStopSucceeded, false);
  assert.ok(stopError);
  assert.equal(health.active_browser_turns, 1);
  assert.equal(health.accepting_turns, true);
  assert.equal(controls.includes("cancel-turns"), false, "no unguarded fallback");
} finally {
  request.destroy();
  chatGptTurnSessions.clear();
  await server.stop(true);
}


});
