const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

for (const resolved of [false, true]) test(`managed tunnel commands isolate the API key and extend MCP lifetime (resolved: ${resolved})`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-ttl-"));
  const script = path.join(root, "print-env.cjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ttl: process.env.MCP_CONNECTION_MAX_TTL, key: process.env.CODEX_CHATGPT_WEB_API_KEY || 'absent', descriptor: process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR}));\n");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "2.1.1", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const previous = process.env.CODEX_CHATGPT_WEB_API_KEY;
    process.env.CODEX_CHATGPT_WEB_API_KEY = "parent-only-secret";
    try {
      const result = await supervisor.runTunnelCommand(
        { tunnel: { binaryPath: process.execPath, profileDir: root } },
        [script],
        5_000,
        "Tunnel TTL probe",
        ...(resolved ? [{ ...process.env, CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: "untrusted-descriptor" }] : []),
      );
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        ttl: "24h", key: "absent", descriptor: path.join(root, "launcher.json"),
      });
      assert.equal(process.env.CODEX_CHATGPT_WEB_API_KEY, "parent-only-secret");
    } finally {
      if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_API_KEY;
      else process.env.CODEX_CHATGPT_WEB_API_KEY = previous;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
