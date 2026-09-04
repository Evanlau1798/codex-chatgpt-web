const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");

for (const profile of ["production", "development"]) {
  for (const configured of [true, false]) {
    test(`${profile} setup rollback restores both tunnel profiles (configured: ${configured})`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-profile-rollback-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const coreHome = path.join(root, "core");
      const configPath = path.join(coreHome, "config.json");
      const automaticTunnel = {
        runtimeKeyFile: path.join(root, "custom", "automatic.key"),
        profileDir: path.join(root, "custom"), profileName: "automatic",
      };
      const manualTunnel = {
        runtimeKeyFile: path.join(root, "custom", "manual.key"),
        profileDir: path.join(root, "custom"), profileName: "manual",
      };
      const config = {
        mode: "full", browserHost: "launcher", releaseVersion: "old",
        tunnel: automaticTunnel, automaticTunnel, manualTunnel,
        ...(profile === "development" ? { purpose: "dev-harness" } : {}),
      };
      const paths = [
        ...["tunnel-runtime.key", "tunnel-runtime-automatic.key", "tunnel-runtime-zero-risk.key"]
          .map(name => path.join(coreHome, "secrets", name)),
        ...["codex-chatgpt-web", "codex-chatgpt-web-zero-risk", "codex-chatgpt-web-dev", "codex-chatgpt-web-dev-zero-risk"]
          .map(name => path.join(coreHome, "tunnel", "profiles", `${name}.yaml`)),
        ...(configured ? [automaticTunnel, manualTunnel].flatMap(tunnel => [
          tunnel.runtimeKeyFile, path.join(tunnel.profileDir, `${tunnel.profileName}.yaml`),
        ]) : []),
      ];
      for (const file of [configPath, ...paths]) fs.mkdirSync(path.dirname(file), { recursive: true });
      if (configured) {
        fs.writeFileSync(configPath, JSON.stringify(config));
        for (const file of paths) fs.writeFileSync(file, "original fixture value\n", { mode: 0o600 });
      }
      const readConfig = () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
      let stops = 0;
      const supervisor = {
        coreHome, configPath, readSetupConfig: readConfig, readConfig,
        stopForSetup: async () => { stops += 1; return { status: "stopped" }; },
        clearState() {},
        startIfConfigured: async () => {
          const current = readConfig();
          if (current?.releaseVersion === "candidate") throw new Error("candidate startup failed");
          return { status: current ? "ready" : "not-configured" };
        },
      };
      const host = new RuntimeHost({
        app: { getPath: () => path.join(root, "launcher") },
        logger: { info() {}, warn() {}, error() {} },
        sourceRoot: root, coreHome, codexHome: path.join(root, "codex"),
        browserDescriptorPath: path.join(root, "browser.json"),
        launcherProfile: profile, supervisor,
      });
      host.claudeHome = path.join(root, "claude");
      host.run = async (_name, args) => {
        if (!args.includes("--preflight-only")) {
          fs.writeFileSync(configPath, JSON.stringify({ ...config, releaseVersion: "candidate" }));
          for (const file of paths) fs.writeFileSync(file, "candidate fixture value\n");
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      await assert.rejects(host.runSetup("setup", ["setup", "--full"], {}), /candidate startup failed/);
      assert.ok(stops >= 1);
      assert.deepEqual(readConfig(), configured ? config : null);
      for (const file of paths) {
        if (configured) assert.equal(fs.readFileSync(file, "utf8"), "original fixture value\n", file);
        else assert.equal(fs.existsSync(file), false, file);
      }
    });
  }
}
