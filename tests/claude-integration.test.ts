import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getClaudeIntegrationJournalPath,
  getClaudeSettingsPath,
  installClaudeIntegration,
  preflightClaudeIntegration,
  refreshClaudeIntegrationRuntimeCredentials,
  uninstallClaudeIntegration,
} from "../src/claude-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

function fixture(initial?: Record<string, unknown>) {
  const root = join(tmpdir(), `codex-chatgpt-web-claude-${process.pid}-${Date.now()}-${Math.random()}`);
  const claudeHome = join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  roots.push(root);
  if (initial) {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), `${JSON.stringify(initial, null, 2)}\n`);
  }
  return { root, settingsPath: join(claudeHome, "settings.json") };
}

function settings(): Record<string, any> {
  return JSON.parse(readFileSync(getClaudeSettingsPath(), "utf8"));
}

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reversible Claude Code integration", () => {
  test("installs a working bare-Claude default backed by the discovered gateway model list", () => {
    fixture({ language: "traditional-chinese", env: { USER_SETTING: "keep" } });

    const config = defaultConfig("browser-only");
    installClaudeIntegration(config);

    const installed = settings();
    expect(installed.language).toBe("traditional-chinese");
    expect(installed.model).toBe("claude-chatgpt-web-high");
    expect(installed.availableModels).toEqual([
      "claude-chatgpt-web-high",
      "claude-chatgpt-web-light",
      "claude-chatgpt-web-medium",
    ]);
    expect(installed.enforceAvailableModels).toBe(true);
    expect(installed.env).toMatchObject({
      USER_SETTING: "keep",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:17841",
      ANTHROPIC_AUTH_TOKEN: "codex-chatgpt-web-local",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CODEX_CHATGPT_WEB_CONTROL_TOKEN: config.controlToken,
    });
    expect(installed.env).not.toHaveProperty("CLAUDE_CODE_BRIEF");
    const steeringHook = {
      hooks: [{
        type: "http",
        url: "http://127.0.0.1:17841/v1/messages/steering",
        timeout: 5,
        headers: { Authorization: "Bearer $CODEX_CHATGPT_WEB_CONTROL_TOKEN" },
        allowedEnvVars: ["CODEX_CHATGPT_WEB_CONTROL_TOKEN"],
      }],
    };
    expect(installed.hooks.UserPromptSubmit).toContainEqual(steeringHook);
    expect(installed.hooks.PostToolUse).toContainEqual(steeringHook);
    expect(installed.hooks.PostToolUseFailure).toContainEqual(steeringHook);
    expect(existsSync(getClaudeIntegrationJournalPath())).toBe(true);
  });

  test("exposes Luna and Think to Claude Code on Luna-only accounts", () => {
    fixture();
    const config = defaultConfig("browser-only");
    config.solAvailable = false;

    installClaudeIntegration(config);

    const installed = settings();
    expect(installed.model).toBe("claude-chatgpt-web-luna");
    expect(installed.availableModels).toEqual([
      "claude-chatgpt-web-luna",
      "claude-chatgpt-web-think",
    ]);
    uninstallClaudeIntegration();
    expect(existsSync(getClaudeSettingsPath())).toBe(false);
  });

  test("upgrades the legacy single-event steering hook without leaving it behind on uninstall", () => {
    fixture();
    const config = defaultConfig("browser-only");
    installClaudeIntegration(config);
    const legacySettings = settings();
    delete legacySettings.hooks.PostToolUse;
    delete legacySettings.hooks.PostToolUseFailure;
    writeFileSync(getClaudeSettingsPath(), `${JSON.stringify(legacySettings, null, 2)}\n`);
    const legacyJournal = JSON.parse(readFileSync(getClaudeIntegrationJournalPath(), "utf8"));
    delete legacyJournal.installed.hookEvents;
    delete legacyJournal.installed.hookEventsAdded;
    legacyJournal.installed.hookAdded = true;
    writeFileSync(getClaudeIntegrationJournalPath(), `${JSON.stringify(legacyJournal, null, 2)}\n`);

    installClaudeIntegration(config);
    expect(settings().hooks.PostToolUse).toHaveLength(1);
    expect(settings().hooks.PostToolUseFailure).toHaveLength(1);
    expect(settings().env).not.toHaveProperty("CLAUDE_CODE_BRIEF");
    uninstallClaudeIntegration();
    expect(existsSync(getClaudeSettingsPath())).toBe(false);
  });

  test("retires a managed Brief value and restores its original user value", () => {
    fixture({ env: { CLAUDE_CODE_BRIEF: "user-value", KEEP: "value" } });
    const config = defaultConfig("browser-only");
    installClaudeIntegration(config);
    const legacySettings = settings();
    legacySettings.env.CLAUDE_CODE_BRIEF = "1";
    writeFileSync(getClaudeSettingsPath(), `${JSON.stringify(legacySettings, null, 2)}\n`);
    const legacyJournal = JSON.parse(readFileSync(getClaudeIntegrationJournalPath(), "utf8"));
    legacyJournal.installed.env.CLAUDE_CODE_BRIEF = "1";
    legacyJournal.previous.env.CLAUDE_CODE_BRIEF = { present: true, value: "user-value" };
    writeFileSync(getClaudeIntegrationJournalPath(), `${JSON.stringify(legacyJournal, null, 2)}\n`);

    installClaudeIntegration(config);

    expect(settings().env.CLAUDE_CODE_BRIEF).toBe("user-value");
    const upgradedJournal = JSON.parse(readFileSync(getClaudeIntegrationJournalPath(), "utf8"));
    expect(upgradedJournal.installed.env).not.toHaveProperty("CLAUDE_CODE_BRIEF");
    expect(upgradedJournal.previous.env).not.toHaveProperty("CLAUDE_CODE_BRIEF");
  });

  test("restores only managed settings and preserves unrelated edits made after install", () => {
    const userHook = { hooks: [{ type: "command", command: "user-hook" }] };
    fixture({
      model: "user-model",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example", CLAUDE_CODE_BRIEF: "user-value", KEEP: "before" },
      hooks: { UserPromptSubmit: [userHook] },
    });
    installClaudeIntegration(defaultConfig("browser-only"));
    const edited = settings();
    edited.env.KEEP = "after";
    edited.statusLine = { type: "command", command: "status" };
    writeFileSync(getClaudeSettingsPath(), `${JSON.stringify(edited, null, 2)}\n`);

    expect(uninstallClaudeIntegration()).toEqual({ changed: true });

    expect(settings()).toEqual({
      model: "user-model",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example", CLAUDE_CODE_BRIEF: "user-value", KEEP: "after" },
      hooks: { UserPromptSubmit: [userHook] },
      statusLine: { type: "command", command: "status" },
    });
    expect(existsSync(getClaudeIntegrationJournalPath())).toBe(false);
  });

  test("refuses to overwrite a changed managed model unless replacement is explicit", () => {
    fixture({ model: "user-model" });
    const config = defaultConfig("browser-only");
    installClaudeIntegration(config);
    const edited = settings();
    edited.model = "another-model";
    writeFileSync(getClaudeSettingsPath(), `${JSON.stringify(edited, null, 2)}\n`);

    expect(() => preflightClaudeIntegration(config)).toThrow("Claude model changed after setup");
    expect(() => installClaudeIntegration(config)).toThrow("Claude model changed after setup");
    installClaudeIntegration(config, { replaceExistingRoute: true });
    expect(settings().model).toBe("claude-chatgpt-web-high");

    uninstallClaudeIntegration();
    expect(settings().model).toBe("another-model");
  });

  test("preserves a selected available model while upgrading managed settings", () => {
    fixture();
    const config = defaultConfig("browser-only");
    installClaudeIntegration(config);
    const edited = settings();
    edited.model = "claude-chatgpt-web-medium";
    writeFileSync(getClaudeSettingsPath(), `${JSON.stringify(edited, null, 2)}\n`);

    preflightClaudeIntegration(config);
    installClaudeIntegration(config);

    expect(settings().model).toBe("claude-chatgpt-web-medium");
    expect(() => preflightClaudeIntegration(config)).not.toThrow();
  });

  test("refreshes a stale managed steering token after the runtime token rotates", () => {
    fixture({ language: "traditional-chinese", env: { KEEP: "value" } });
    const original = defaultConfig("browser-only");
    installClaudeIntegration(original);
    const rotated = { ...original, controlToken: "r".repeat(43) };

    expect(refreshClaudeIntegrationRuntimeCredentials(rotated)).toBe(true);
    expect(settings()).toMatchObject({
      language: "traditional-chinese",
      env: {
        KEEP: "value",
        CODEX_CHATGPT_WEB_CONTROL_TOKEN: rotated.controlToken,
      },
    });
    const journal = JSON.parse(readFileSync(getClaudeIntegrationJournalPath(), "utf8"));
    expect(journal.installed.env.CODEX_CHATGPT_WEB_CONTROL_TOKEN).toBe(rotated.controlToken);
    expect(refreshClaudeIntegrationRuntimeCredentials(rotated)).toBe(false);
  });

  test("does not overwrite a steering token edited outside the managed integration", () => {
    fixture();
    const original = defaultConfig("browser-only");
    installClaudeIntegration(original);
    const edited = settings();
    edited.env.CODEX_CHATGPT_WEB_CONTROL_TOKEN = "u".repeat(43);
    writeFileSync(getClaudeSettingsPath(), `${JSON.stringify(edited, null, 2)}\n`);

    expect(refreshClaudeIntegrationRuntimeCredentials({ ...original, controlToken: "r".repeat(43) })).toBe(false);
    expect(settings().env.CODEX_CHATGPT_WEB_CONTROL_TOKEN).toBe("u".repeat(43));
  });
});
