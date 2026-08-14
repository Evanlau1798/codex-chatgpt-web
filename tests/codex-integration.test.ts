import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  installCodexIntegration,
  inspectCodexIntegration,
  preflightCodexIntegration,
  readCodexModelContextOverride,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string; appHome: string } {
  const root = join(tmpdir(), `codex-chatgpt-web-integration-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  const appHome = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  return { root, codexHome, appHome };
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reversible native Codex route integration", () => {
  test("expands a configured tilde Codex home consistently with launcher paths", () => {
    process.env.CODEX_HOME = "~/custom-codex-home";
    expect(getCodexHome()).toBe(join(homedir(), "custom-codex-home"));
  });

  test("reads the selected model's explicit context override from Codex config", () => {
    const { codexHome } = fixture();
    writeFileSync(
      join(codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_context_window = 371_851 # explicit override\n',
    );

    expect(readCodexModelContextOverride()).toEqual({
      model: "gpt-5.6-sol",
      contextWindow: 371_851,
    });
  });

  test("keeps the built-in openai provider and manages the bounded V1 Web surface", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.version).toBe(6);
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).toContain("multi_agent = true # Managed by codex-chatgpt-web");
    expect(installed).toContain("multi_agent_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).not.toContain("multi_agent = false");
    expect(installed).toContain("goals = true");
    expect(installed).not.toMatch(/^\s*model_provider\s*=/m);
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);
    expect(installed).not.toContain("[model_providers.codex-chatgpt-web]");
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8"))
      .toBe(readFileSync(getCodexJournalPath(), "utf8"));

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(getCodexJournalRecoveryPath())).toBe(false);
    expect(uninstallCodexIntegration()).toEqual({ changed: false });
  });

  test("restores a missing primary journal from its exact recovery copy", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const recovery = readFileSync(getCodexJournalRecoveryPath(), "utf8");
    rmSync(getCodexJournalPath());

    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(recovery);
  });

  test("refuses different journal baselines when both match the same config", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const recovery = JSON.parse(readFileSync(getCodexJournalRecoveryPath(), "utf8"));
    recovery.previous.model_provider = { present: false, rawLine: "different but inactive evidence" };
    writeFileSync(getCodexJournalRecoveryPath(), `${JSON.stringify(recovery, null, 2)}\n`);

    expect(() => inspectCodexIntegration()).toThrow("different baselines");
  });

  test("reconciles either side of a crash between recovery intent, config, and primary commit", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const activeConfig = readFileSync(configPath, "utf8");
    const activeJournal = readFileSync(getCodexJournalPath(), "utf8");

    deactivateCodexIntegration();
    const inactiveConfig = readFileSync(configPath, "utf8");
    const inactiveJournal = readFileSync(getCodexJournalRecoveryPath(), "utf8");

    // Recovery intent and config reached disk, but primary still describes the old active state.
    writeFileSync(getCodexJournalPath(), activeJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(inactiveJournal);

    // Only the next active intent reached disk; physical config and primary are still inactive.
    writeFileSync(getCodexJournalRecoveryPath(), activeJournal);
    writeFileSync(configPath, inactiveConfig);
    writeFileSync(getCodexJournalPath(), inactiveJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(inactiveJournal);
    expect(readFileSync(configPath, "utf8")).not.toBe(activeConfig);
  });

  test("accepts an explicitly persisted built-in openai provider and restores it exactly", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nmodel_provider = "openai" # explicit built-in default\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(defaultConfig("browser-only"))).not.toThrow();
    installCodexIntegration(defaultConfig("browser-only"));
    expect(readFileSync(configPath, "utf8")).not.toMatch(/^\s*model_provider\s*=/m);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restores an explicit remote_compaction_v2 setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nremote_compaction_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).not.toContain("remote_compaction_v2 = true");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restores an explicit multi_agent setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent = true # Managed by codex-chatgpt-web");
    expect(installed).not.toContain("multi_agent = false");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restores an explicit multi_agent_v2 setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).not.toContain("multi_agent_v2 = true");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("manages and restores the structured multi_agent_v2 feature table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[features.multi_agent_v2]",
      "enabled = true # user choice",
      "hide_spawn_agent_metadata = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).not.toMatch(/^multi_agent_v2\s*=/m);
    expect(installed).toContain(
      "enabled = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable.",
    );
    expect(installed).toContain("hide_spawn_agent_metadata = true");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("invalidates Codex's provider-agnostic model cache on install and uninstall", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const cachePath = getCodexModelsCachePath();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    writeFileSync(cachePath, '{"models":["native-only"]}\n');

    installCodexIntegration(defaultConfig("browser-only"));
    expect(() => readFileSync(cachePath, "utf8")).toThrow();

    writeFileSync(cachePath, '{"models":["native-and-web"]}\n');
    uninstallCodexIntegration();
    expect(() => readFileSync(cachePath, "utf8")).toThrow();
  });

  test("requires explicit replacement and restores every prior route assignment", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\nmodel_provider = "existing-provider"\nopenai_base_url = "http://127.0.0.1:9999/v1"\nmodel_catalog_json = "/tmp/native.json"\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);
    const config = defaultConfig("full");

    expect(() => installCodexIntegration(config)).toThrow("--replace-codex-route");
    installCodexIntegration(config, { replaceExistingRoute: true });
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).not.toMatch(/^\s*model_provider\s*=/m);
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preflight detects route conflicts without changing Codex or creating a journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:9999/v1"\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(defaultConfig("browser-only")))
      .toThrow("--replace-codex-route");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(() => readFileSync(getCodexJournalPath(), "utf8")).toThrow();
  });

  test("updates its own route idempotently without changing the preserved baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const first = defaultConfig("browser-only");
    installCodexIntegration(first);
    const second = defaultConfig("browser-only");
    second.port = 17842;
    installCodexIntegration(second);
    expect(readFileSync(configPath, "utf8")).toContain('openai_base_url = "http://127.0.0.1:17842/v1"');
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("disconnects and reconnects the bridge without losing the prior route or journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\napproval_policy = "never"\nopenai_base_url = "https://native.example/v1"\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"), { replaceExistingRoute: true });
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false });
    expect(deactivateCodexIntegration()).toEqual({ changed: false, active: false });

    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    const reconnected = readFileSync(configPath, "utf8");
    expect(reconnected).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(reconnected).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(reconnected).toContain("multi_agent = true # Managed by codex-chatgpt-web");
    expect(reconnected).toContain("multi_agent_v2 = false # Managed by codex-chatgpt-web");
    expect(reconnected).toContain('approval_policy = "never"');
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true });
    expect(activateCodexIntegration()).toEqual({ changed: false, active: true });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("keeps a disconnected bridge disabled across process-style journal reloads", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();

    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 6,
      active: false,
    });
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("upgrades an existing v3 route journal when it is disconnected for the first time", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n';
    writeFileSync(configPath, original);
    installCodexIntegration(defaultConfig("browser-only"));
    const previous = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    const legacyInstalled = readFileSync(configPath, "utf8")
      .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, "");
    writeFileSync(configPath, legacyInstalled);
    delete previous.active;
    delete previous.previousRemoteCompactionV2;
    delete previous.previousMultiAgent;
    delete previous.previousMultiAgentV2;
    delete previous.installed.remote_compaction_v2;
    delete previous.installed.multi_agent;
    delete previous.installed.multi_agent_v2;
    previous.version = 3;
    writeFileSync(getCodexJournalPath(), `${JSON.stringify(previous, null, 2)}\n`);

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 4,
      active: false,
    });
  });

  test("upgrades an active v4 route journal to the managed V1 Web surface", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    delete legacy.previousRemoteCompactionV2;
    delete legacy.previousMultiAgent;
    delete legacy.previousMultiAgentV2;
    delete legacy.installed.remote_compaction_v2;
    delete legacy.installed.multi_agent;
    delete legacy.installed.multi_agent_v2;
    legacy.version = 4;
    writeFileSync(getCodexJournalPath(), `${JSON.stringify(legacy, null, 2)}\n`);
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8")
        .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, ""),
    );

    const upgraded = installCodexIntegration(defaultConfig("browser-only"));
    expect(upgraded.version).toBe(6);
    expect(readFileSync(configPath, "utf8")).toContain(
      "remote_compaction_v2 = false # Managed by codex-chatgpt-web",
    );
    expect(readFileSync(configPath, "utf8")).toContain(
      "multi_agent = true # Managed by codex-chatgpt-web",
    );
    expect(readFileSync(configPath, "utf8")).toContain(
      "multi_agent_v2 = false # Managed by codex-chatgpt-web",
    );
  });

  test("upgrades an active v5 journal without losing its preserved feature baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);
    installCodexIntegration(defaultConfig("full"));
    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    delete legacy.previousMultiAgentV2;
    delete legacy.installed.multi_agent_v2;
    legacy.version = 5;
    writeFileSync(getCodexJournalPath(), `${JSON.stringify(legacy, null, 2)}\n`);
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        /^multi_agent_v2 = false.*$/m,
        "multi_agent_v2 = true # user choice",
      ),
    );

    const upgraded = installCodexIntegration(defaultConfig("full"));
    expect(upgraded.version).toBe(6);
    expect(readFileSync(configPath, "utf8")).toContain(
      "multi_agent_v2 = false # Managed by codex-chatgpt-web",
    );

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("fails closed when the native route changes while the bridge is disconnected", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\nopenai_base_url = "https://newer.example/v1"\n');

    expect(() => activateCodexIntegration()).toThrow("changed while the bridge was disconnected");
    expect(readFileSync(configPath, "utf8")).toContain("https://newer.example/v1");
  });

  test("uninstalls cleanly while the bridge is disconnected", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(configPath, original);
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(inspectCodexIntegration()).toMatchObject({ installed: false, active: false });
  });

  test("does not apply one application home's journal to a different Codex home", () => {
    const { root, codexHome } = fixture();
    const firstConfig = join(codexHome, "config.toml");
    writeFileSync(firstConfig, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));

    const secondCodexHome = join(root, "other-codex");
    mkdirSync(secondCodexHome, { recursive: true });
    const secondConfig = join(secondCodexHome, "config.toml");
    writeFileSync(secondConfig, 'model = "gpt-5.5"\n');
    process.env.CODEX_HOME = secondCodexHome;

    expect(() => preflightCodexIntegration(defaultConfig("browser-only")))
      .toThrow("journal belongs");
    expect(readFileSync(secondConfig, "utf8")).toBe('model = "gpt-5.5"\n');
  });

  test("preserves Windows line endings and a missing final newline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const windowsOriginal = 'model = "gpt-5.6-sol"\r\n\r\n[features]\r\ngoals = true';
    writeFileSync(configPath, windowsOriginal);

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('\r\nopenai_base_url = "http://127.0.0.1:17841/v1"\r\n');
    expect(installed.endsWith("\n")).toBe(false);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(windowsOriginal);
  });

  test("migrates the removed static-catalog integration without reviving a missing foreign catalog", () => {
    const { codexHome, appHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const managedCatalog = join(appHome, "codex", "model-catalog.json");
    mkdirSync(join(appHome, "codex"), { recursive: true });
    writeFileSync(managedCatalog, "managed\n");
    const providerBlock = '# BEGIN codex-chatgpt-web provider\n[model_providers.codex-chatgpt-web]\nname = "Codex + ChatGPT Web"\n# END codex-chatgpt-web provider';
    writeFileSync(configPath, `model = "gpt-5.6-sol"\nmodel_catalog_json = ${JSON.stringify(managedCatalog)}\nmodel_provider = "codex-chatgpt-web"\n\n${providerBlock}\n`);
    writeFileSync(getCodexJournalPath(), JSON.stringify({
      version: 2,
      configPath,
      catalogPath: managedCatalog,
      catalogSha256: new Bun.CryptoHasher("sha256").update("managed\n").digest("hex"),
      providerBlock,
      installed: { model_provider: "codex-chatgpt-web", model_catalog_json: managedCatalog },
      previous: {
        model_provider: { present: false },
        model_catalog_json: { present: true, rawLine: 'model_catalog_json = "/missing/custom-catalog.json"', value: "/missing/custom-catalog.json" },
      },
    }));

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).not.toContain("custom-catalog");
    expect(installed).not.toContain("model_catalog_json");
    expect(installed).not.toContain("model_provider");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
  });

  test("fails closed when the installed route changed after setup", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const changed = readFileSync(configPath, "utf8").replace("17841", "17842");
    writeFileSync(configPath, changed);
    expect(() => uninstallCodexIntegration()).toThrow("changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });

  test("explicit replacement adopts a newer Codex route as the reversible baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "https://first.example/v1"',
      "",
      "[features]",
      "remote_compaction_v2 = true # user choice",
      "multi_agent = false # user choice",
      "multi_agent_v2 = true # user choice",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const config = defaultConfig("full");

    installCodexIntegration(config, { replaceExistingRoute: true });
    const changed = readFileSync(configPath, "utf8")
      .replace('openai_base_url = "http://127.0.0.1:17841/v1"', 'openai_base_url = "https://newer.example/v1"');
    writeFileSync(configPath, changed);

    expect(() => preflightCodexIntegration(config)).toThrow("changed after setup");
    expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).not.toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(changed);

    installCodexIntegration(config, { replaceExistingRoute: true });
    expect(readFileSync(configPath, "utf8")).toContain(
      'openai_base_url = "http://127.0.0.1:17841/v1"',
    );
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(
      original.replace("https://first.example/v1", "https://newer.example/v1"),
    );
  });

  test("explicit replacement recovers a stale journal after Codex config was deleted", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const config = defaultConfig("browser-only");
    installCodexIntegration(config);
    rmSync(configPath);

    expect(() => preflightCodexIntegration(config)).toThrow("Codex config is missing");
    expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).not.toThrow();
    expect(() => readFileSync(configPath, "utf8")).toThrow();

    installCodexIntegration(config, { replaceExistingRoute: true });
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe("");
  });

  test("plain setup stays fail-closed when a disconnected integration config was deleted", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const config = defaultConfig("browser-only");
    installCodexIntegration(config);
    deactivateCodexIntegration();
    rmSync(configPath);

    expect(() => preflightCodexIntegration(config)).toThrow("Codex config is missing");
    expect(() => installCodexIntegration(config)).toThrow("Codex config is missing");
    expect(existsSync(configPath)).toBe(false);
  });

  test("explicit replacement restores still-owned provider fields while adopting a changed URL", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "https://first.example/v1"',
      'model_provider = "openai"',
      'model_catalog_json = "/tmp/original-models.json"',
      "",
      "[features]",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const config = defaultConfig("browser-only");
    installCodexIntegration(config, { replaceExistingRoute: true });
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        'openai_base_url = "http://127.0.0.1:17841/v1"',
        'openai_base_url = "https://newer.example/v1"',
      ),
    );

    installCodexIntegration(config, { replaceExistingRoute: true });
    deactivateCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(
      original.replace("https://first.example/v1", "https://newer.example/v1"),
    );
  });

  test("explicit replacement adopts a new provider while restoring the still-owned URL and catalog", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "https://first.example/v1"',
      'model_provider = "openai"',
      'model_catalog_json = "/tmp/original-models.json"',
      "",
      "[features]",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const config = defaultConfig("browser-only");
    installCodexIntegration(config, { replaceExistingRoute: true });
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "\n[features]",
        '\nmodel_provider = "custom-provider"\n\n[features]',
      ),
    );

    installCodexIntegration(config, { replaceExistingRoute: true });
    deactivateCodexIntegration();
    const restored = readFileSync(configPath, "utf8");
    expect(restored).toContain('openai_base_url = "https://first.example/v1"');
    expect(restored).toContain('model_provider = "custom-provider"');
    expect(restored).toContain('model_catalog_json = "/tmp/original-models.json"');
    expect(restored).not.toContain("127.0.0.1:17841");
  });

  test("fails closed when the managed compaction feature changes after setup", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const changed = readFileSync(configPath, "utf8")
      .replace(/^remote_compaction_v2 = false.*$/m, "remote_compaction_v2 = true");
    writeFileSync(configPath, changed);

    expect(() => uninstallCodexIntegration()).toThrow("remote_compaction_v2 changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });

  test("fails closed when the managed multi-agent feature changes after setup", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("full"));
    const changed = readFileSync(configPath, "utf8")
      .replace(/^multi_agent = true.*$/m, "multi_agent = false");
    writeFileSync(configPath, changed);

    expect(() => uninstallCodexIntegration()).toThrow("multi_agent changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });

  test("fails closed when the managed V1 subagent transport changes after setup", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("full"));
    const changed = readFileSync(configPath, "utf8")
      .replace(/^multi_agent_v2 = false.*$/m, "multi_agent_v2 = true");
    writeFileSync(configPath, changed);

    expect(() => uninstallCodexIntegration()).toThrow("multi_agent_v2 changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });

  test("keeps every user line byte-for-byte when line endings are mixed", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\r\napproval_policy = "never"\n\r\n[features]\ngoals = true\r\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    for (const line of [
      'model = "gpt-5.6-sol"\r\n',
      'approval_policy = "never"\n',
      "[features]\n",
      "goals = true\r\n",
    ]) {
      expect(installed).toContain(line);
    }
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});
