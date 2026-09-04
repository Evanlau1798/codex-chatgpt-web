import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { defaultConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";

function fixture(run: (root: string, invoke: (args: string[]) => { exitCode: number; stdout: string; stderr: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "cgw-preflight-"));
  const env = { ...process.env, CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude") };
  for (const path of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) mkdirSync(path);
  const snapshot = () => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = join(entry.parentPath, entry.name);
      return [relative(root, file), readFileSync(file).toString("hex")];
    }).sort();
  try {
    run(root, args => {
      const before = snapshot();
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"),
        "--home", join(root, "core"), "setup", "--preflight-only", "--acknowledge-unofficial",
        "--browser-host-descriptor", join(root, "absent-browser.json"), ...args],
      { env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(snapshot()).toEqual(before);
      return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const target of [[], ["--codex-only"], ["--claude-only"]]) {
  test(`preflight validates ${target[0] ?? "both integrations"} without installing or inspecting a browser`, () => {
    fixture((_root, invoke) => {
      const result = invoke(["--browser-only", ...target]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Setup preflight complete.");
    });
  });
}

test("manual preflight requires its own tunnel and key before any setup side effect", () => {
  fixture((root, invoke) => {
    const args = ["--full", "--zero-risk-browser-interaction"];
    expect(invoke(args).stderr.toString()).toContain("Zero Risk mode needs its own MCP Tunnel ID");
    args.push("--tunnel-id", "tunnel_0123456789abcdef0123456789abcdef");
    expect(invoke(args).stderr.toString()).toContain("Zero Risk mode needs its own MCP runtime key");
    const key = join(root, "key");
    writeFileSync(key, "fixture-key-not-a-real-secret");
    expect(invoke([...args, "--runtime-key-file", key]).exitCode).toBe(0);
  });
});

test("preflight honors the selected integration instead of validating an unrelated client", () => {
  fixture((root, invoke) => {
    writeFileSync(join(root, "claude/settings.json"), "{ invalid JSON");
    expect(invoke(["--browser-only", "--codex-only"]).exitCode).toBe(0);
    for (const target of [[], ["--claude-only"]]) {
      const result = invoke(["--browser-only", ...target]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Claude settings");
    }
  });
});

for (const state of ["missing recovery", "missing primary", "corrupt recovery", "divergent recovery"]) {
  test(`failed preflight never repairs ${state} journal`, () => {
    fixture((root, invoke) => {
      const previous = { CODEX_HOME: process.env.CODEX_HOME, CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME };
      try {
        process.env.CODEX_HOME = join(root, "codex");
        process.env.CODEX_CHATGPT_WEB_HOME = join(root, "core");
        installCodexIntegration({ ...defaultConfig("browser-only"), subagentProtocol: "native" });
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      const primary = join(root, "core/codex/integration-journal.json");
      const recovery = join(root, "core/codex/integration-journal.recovery.json");
      if (state === "missing recovery") rmSync(recovery);
      else if (state === "missing primary") rmSync(primary);
      else if (state === "corrupt recovery") writeFileSync(recovery, "invalid");
      else {
        const journal = JSON.parse(readFileSync(recovery, "utf8"));
        journal.installed.openai_base_url = "http://127.0.0.1:1/v1";
        writeFileSync(recovery, JSON.stringify(journal));
      }
      for (const target of [[], ["--claude-only"], ["--subagent-protocol", "native"]]) {
        const result = invoke(["--full", "--zero-risk-browser-interaction", ...target]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Zero Risk mode needs its own MCP Tunnel ID");
      }
    });
  });
}
