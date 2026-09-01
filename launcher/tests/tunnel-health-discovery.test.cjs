const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function supervisor(root) {
  return new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
}

const config = root => ({
  tunnel: { alias: "codex-chatgpt-web", binaryPath: path.join(root, "tunnel-client"), profileDir: root },
});

test("fresh tunnel recovery rediscovers official loopback diagnostics before MCP probing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-tunnel-health-discovery-"));
  const runtime = supervisor(root);
  const commands = [];
  runtime.runTunnelCommand = async (_config, args) => {
    commands.push(args);
    return { code: 0, output: JSON.stringify({ local: { health: { base_url: "http://127.0.0.1:43127" } } }) };
  };
  runtime.probeTunnelMcpTransport = async () => ({ observed: true, ok: true, fatal: false, detail: "healthy" });
  try {
    await runtime.waitForTunnelMcpTransport(config(root), 25);
    assert.equal(runtime.tunnelHealthBaseUrl, "http://127.0.0.1:43127");
    assert.deepEqual(commands, [["runtimes", "status", "codex-chatgpt-web", "--json"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official tunnel health discovery rejects non-loopback endpoints", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-tunnel-health-nonlocal-"));
  const runtime = supervisor(root);
  runtime.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({ health_url: "https://example.com/healthz" }),
  });
  try {
    await assert.rejects(runtime.discoverTunnelHealthBaseUrl(config(root)), /no verified loopback endpoint/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
