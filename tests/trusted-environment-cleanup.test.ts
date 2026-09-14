import { expect, test } from "bun:test";
import { MissingTrustedCodexEnvironmentError } from "../src/adapters/chatgpt-web/environment";
import { resolveTrustedCodexEnvironment } from "../src/adapters/chatgpt-web/trusted-environment-lifecycle";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-session-registry";
import { ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { parseRequest } from "../src/responses/parser";

test("accepted environment keeps an owned pending tool continuation alive", async () => {
  const sessions = new ChatGptTurnSessions();
  const browser = deferred<string>();
  const physical = deferred<void>();
  const session = sessions.getOrCreate("owned-key", () => ({
    mode: "tools", token: Promise.resolve("turn_owned"), browser: browser.promise,
    physicalSettlement: physical.promise, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    nativeIdentity: { threadId: "thread-owned", turnId: "turn-owned" },
    cancel: () => browser.reject(new Error("cancelled")),
    release: async () => {},
  }));
  session.setOutstanding([{ callId: "call-owned", wireName: "apply_patch", freeform: true, arguments: {} }]);
  const parsed = parseRequest({ model: "chatgpt-web/extra-high", client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-owned", turn_id: "turn-owned" }),
  }, input: [{ type: "custom_tool_call_output", call_id: "call-owned", output: "ok" }] });
  const store = new ChatGptThreadEnvironmentStore();
  store.resolve = () => ({
    cwd: "G:\\repo", roots: ["G:\\repo"], writableRoots: ["G:\\repo"],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  });
  try {
    expect((await resolveTrustedCodexEnvironment(store, parsed, "owned-key", sessions)).cwd).toBe("G:\\repo");
    expect(sessions.find("owned-key")).toBe(session);
  } finally {
    browser.resolve("cleanup"); physical.resolve();
    await sessions.retireAndWait("owned-key");
  }
});

test.each(["owned", "wrong turn", "wrong result", "wrong key"])(
  "rejected environment cleans only an owned pending tool continuation: %s", async scenario => {
    const sessions = new ChatGptTurnSessions();
    const browser = deferred<string>();
    const physical = deferred<void>();
    const cancelled = deferred<void>();
    let releases = 0;
    const session = sessions.getOrCreate("owned-key", () => ({
      mode: "tools", token: Promise.resolve("turn_owned"), browser: browser.promise,
      physicalSettlement: physical.promise, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      nativeIdentity: { threadId: "thread-owned", turnId: "turn-owned" },
      cancel: () => { browser.reject(new Error("cancelled")); cancelled.resolve(); },
      release: async () => { releases++; },
    }));
    session.setOutstanding([{ callId: "call-owned", wireName: "apply_patch", freeform: true, arguments: {} }]);
    const parsed = parseRequest({ model: "chatgpt-web/extra-high", client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-owned", turn_id: scenario === "wrong turn" ? "other" : "turn-owned" }),
    }, input: [{ type: "custom_tool_call_output", call_id: scenario === "wrong result" ? "other" : "call-owned", output: "ok" }] });
    const store = new ChatGptThreadEnvironmentStore();
    store.resolve = () => { throw new MissingTrustedCodexEnvironmentError("cwd"); };
    let settled = false;
    const failure = Promise.resolve().then(() => resolveTrustedCodexEnvironment(
      store, parsed, scenario === "wrong key" ? "other-key" : "owned-key", sessions,
    )).then(() => { throw new Error("unexpected success"); }, error => { settled = true; return error; });
    try {
      if (scenario === "owned") {
        expect(await Promise.race([cancelled.promise.then(() => true), failure.then(() => false)])).toBe(true);
        expect(sessions.find("owned-key")).toBeUndefined();
        await cancelled.promise;
        expect(settled).toBe(false);
        expect(releases).toBe(0);
        physical.resolve();
      }
      expect(await failure).toMatchObject({ code: "missing_trusted_environment" });
      expect(releases).toBe(scenario === "owned" ? 1 : 0);
      if (scenario !== "owned") expect(sessions.find("owned-key")).toBe(session);
    } finally {
      browser.resolve("cleanup"); physical.resolve();
      await sessions.retireAndWait("owned-key");
    }
  },
);
