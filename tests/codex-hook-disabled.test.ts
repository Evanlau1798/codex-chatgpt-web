import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config";
import { installCodexIntegration, preflightCodexIntegration, activateCodexIntegration,
  deactivateCodexIntegration, inspectCodexIntegration } from "../src/codex-integration";

test("a trusted disabled interrupt hook survives setup, update, disconnect and reconnect", () => {
  const root = mkdtempSync(join(tmpdir(), "disabled-hook-"));
  const previous = [process.env.CODEX_HOME, process.env.CODEX_CHATGPT_WEB_HOME];
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "bridge");
  mkdirSync(process.env.CODEX_HOME);
  const path = join(process.env.CODEX_HOME, "config.toml");
  const original = 'model = "gpt-6-sol"\n[features]\ngoals = true\n';
  writeFileSync(path, original);
  try {
    const config = defaultConfig("full"); config.subagentProtocol = "native";
    installCodexIntegration(config);
    writeFileSync(path, readFileSync(path, "utf8").replace("trusted_hash =", "enabled = false\ntrusted_hash ="));
    expect(() => preflightCodexIntegration(config)).not.toThrow();
    expect(inspectCodexIntegration().errors).toEqual([]);
    expect(activateCodexIntegration()).toEqual({ changed: false, active: true });
    for (const update of [config, { ...config, port: config.port + 1 }]) {
      const journal = installCodexIntegration(update);
      const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
      expect(parsed.hooks.state[journal.interruptHook.stateKey].enabled).toBe(false);
      expect(parsed.features.goals).toBe(true);
    }
    deactivateCodexIntegration();
    expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual(Bun.TOML.parse(original));
    activateCodexIntegration();
    const hookState = (Bun.TOML.parse(readFileSync(path, "utf8")) as any).hooks.state;
    expect(Object.values(hookState).every((state: any) => state.enabled === false)).toBe(true);
    // Native settings can enable it again; that choice must also survive reconnect.
    writeFileSync(path, readFileSync(path, "utf8").replace("enabled = false", "enabled = true"));
    deactivateCodexIntegration(); activateCodexIntegration();
    expect(Object.values((Bun.TOML.parse(readFileSync(path, "utf8")) as any).hooks.state)
      .every((state: any) => state.enabled !== false)).toBe(true);
  } finally {
    for (const [i, name] of ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME"].entries()) {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
