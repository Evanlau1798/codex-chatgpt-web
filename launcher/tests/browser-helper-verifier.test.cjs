const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyConnectorWithBrowserHelper } = require("../electron/browser-helper-verifier.cjs");

test("launcher verification delegates exact connector selection to the browser helper protocol", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-verify-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "verify") return;
      if (message.config.appName !== "Codex Native2") process.exit(2);
      if (message.config.browserHostDescriptorPath !== "/runtime/launcher-browser.json") process.exit(3);
      send({ type: "result", id: message.id, text: message.config.appName });
    });
  `);

  const result = await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Codex Native2",
    logger: { info() {} },
  });

  assert.deepEqual(result, { ok: true, appName: "Codex Native2" });
});

test("launcher verification consumes a helper input EOF after the result", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-eof-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type !== "verify") return;
      send({ type: "result", id: message.id, text: message.config.appName });
      process.stdin.destroy();
      setTimeout(() => process.exit(0), 100);
    });
  `);

  const result = await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Codex Native2",
    logger: { info() {} },
  });

  assert.deepEqual(result, { ok: true, appName: "Codex Native2" });
});

test("launcher verification preserves the helper error class and correlation id", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-error-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  const logs = [];
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "verify") return;
      process.stderr.write("private-account private-composer https://chatgpt.com/?secret=value\\n");
      process.stderr.write("[chatgpt-web] browser diagnostic trace=" + message.id + " checkpoint=01-connector-verification-started\\n");
      send({
        type: "error",
        id: message.id,
        name: "ChatGptPersistentBrowserStateError",
        message: "connector proof cleanup failed",
      });
    });
  `);

  await assert.rejects(
    verifyConnectorWithBrowserHelper({
      helper: { executable: process.execPath, script },
      descriptorPath: "/runtime/launcher-browser.json",
      appName: "Codex Native2",
      logger: { info: (event, detail) => logs.push({ event, detail }) },
    }),
    (error) => {
      assert.equal(error.name, "ChatGptPersistentBrowserStateError");
      assert.equal(error.message, "connector proof cleanup failed");
      assert.match(error.operationId, /^verify-[a-f0-9]{24}$/);
      return true;
    },
  );
  assert.doesNotMatch(JSON.stringify(logs), /private-|secret=value/);
  assert.ok(logs.some(log => log.detail.checkpoint === "01-connector-verification-started"));
});
