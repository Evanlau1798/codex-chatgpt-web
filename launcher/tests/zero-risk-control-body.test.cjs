const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { BrowserControlServer } = require("../electron/control-server.cjs");

function fixture() {
  const calls = [];
  const logs = [];
  const host = {
    browserInteractionMode: () => "manual",
    beginManualTurn: (...args) => {
      calls.push(args);
      return { tabId: "manual-tab", reused: false, deadlineAt: null, state: "awaiting-user" };
    },
  };
  const server = new BrowserControlServer({
    logger: Object.fromEntries(["info", "warn", "error"].map(level => [level, (...args) => logs.push(args)])),
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  });
  return { server, calls, logs };
}

const owner = { traceId: "body_limit_test", helperPid: process.pid };
function encodedBody(bytes) {
  const body = { ...owner, prompt: "" };
  body.prompt = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
  return Buffer.from(JSON.stringify(body));
}

test("manual start transports a large UTF-8 prompt and resume suffix without rewriting", async () => {
  const { server, calls, logs } = fixture();
  await server.start();
  try {
    const prompt = "\u6e2c\u8a66\ud83d\ude80".repeat(20_000);
    const resumePrompt = "suffix-".repeat(4_000);
    const response = await fetch(`${server.descriptor().endpoint}/v1/manual/start`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...owner, prompt, resumePrompt, conversationKey: "a".repeat(64) }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(calls, [[owner.traceId, owner.helperPid, prompt, "a".repeat(64), resumePrompt]]);
    assert.equal(JSON.stringify(logs).includes(prompt), false);
  } finally { server.server.closeAllConnections(); await server.close(); }
});

for (const [route, size, authenticated, accepted] of [
  ["start", 3 * 1024 * 1024, true, true],
  ["start", 3 * 1024 * 1024 + 1, true, false],
  ["end", 16 * 1024 + 1, true, false],
  ["start", 20_000, false, false],
]) test(`manual ${route}: bytes=${size}, authenticated=${authenticated}`, async () => {
  const { server, calls } = fixture();
  const body = encodedBody(size);
  const request = Readable.from([body.subarray(0, 1024), body.subarray(1024)]);
  Object.assign(request, {
    method: "POST", url: `/v1/manual/${route}`,
    headers: { authorization: `Bearer ${authenticated ? server.token : "invalid"}` },
  });
  let status;
  let output;
  await server.handle(request, {
    writeHead: value => { status = value; },
    end: value => { output = JSON.parse(value.toString()); },
  });
  assert.equal(status, accepted ? 200 : authenticated ? 400 : 401);
  assert.equal(calls.length, accepted ? 1 : 0);
  if (!accepted && authenticated) assert.equal(output.error, "request body is too large");
});
