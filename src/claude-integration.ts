import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, expandUserPath, getConfigDir, preserveUtf8Bom, stripUtf8Bom } from "./config";
import { preferredClaudeGatewayModelIds } from "./messages/models";

type JsonObject = Record<string, unknown>;
const CLAUDE_STEERING_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"] as const;

interface PreviousValue {
  present: boolean;
  value?: unknown;
}

export interface ClaudeIntegrationJournal {
  version: 1;
  settingsPath: string;
  settingsExisted: boolean;
  previousEnvPresent: boolean;
  installed: {
    settings: JsonObject;
    env: Record<string, string>;
    hook?: JsonObject;
    hookEvents?: string[];
    hookEventsAdded?: string[];
    hookAdded?: boolean;
  };
  previous: {
    settings: Record<string, PreviousValue>;
    env: Record<string, PreviousValue>;
  };
}

export interface InstallClaudeIntegrationOptions {
  replaceExistingRoute?: boolean;
}

interface FileSnapshot {
  path: string;
  exists: boolean;
  data?: Buffer;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as JsonObject;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function capture(target: JsonObject, key: string): PreviousValue {
  return Object.hasOwn(target, key) ? { present: true, value: target[key] } : { present: false };
}

function restore(target: JsonObject, key: string, previous: PreviousValue): void {
  if (previous.present) target[key] = previous.value;
  else delete target[key];
}

function settingsEnv(settings: JsonObject): JsonObject {
  if (!Object.hasOwn(settings, "env")) return {};
  return object(settings.env, "Claude settings env");
}

function selectedAvailableModel(settings: JsonObject, installed: JsonObject): string | undefined {
  const available = installed.availableModels;
  return typeof settings.model === "string" && Array.isArray(available) && available.includes(settings.model)
    ? settings.model
    : undefined;
}

function hookEntries(settings: JsonObject, event: string): { hooks: JsonObject; entries: unknown[] } {
  const hooks = Object.hasOwn(settings, "hooks") ? object(settings.hooks, "Claude settings hooks") : {};
  const raw = hooks[event];
  if (raw !== undefined && !Array.isArray(raw)) throw new Error(`Claude ${event} hooks must be an array`);
  return { hooks, entries: raw ? [...raw] : [] };
}

function managedHookEvents(installed: ClaudeIntegrationJournal["installed"]): string[] {
  return installed.hookEvents ?? ["UserPromptSubmit"];
}

function addedHookEvents(installed: ClaudeIntegrationJournal["installed"]): string[] {
  return installed.hookEventsAdded ?? (installed.hookAdded ? ["UserPromptSubmit"] : []);
}

function hasHook(settings: JsonObject, hook: JsonObject, events: string[]): boolean {
  return events.every(event => hookEntries(settings, event).entries.some(entry => same(entry, hook)));
}

function addHook(settings: JsonObject, hook: JsonObject, events: string[]): string[] {
  const added: string[] = [];
  for (const event of events) {
    const current = hookEntries(settings, event);
    if (current.entries.some(entry => same(entry, hook))) continue;
    current.hooks[event] = [...current.entries, hook];
    settings.hooks = current.hooks;
    added.push(event);
  }
  return added;
}

function removeHook(settings: JsonObject, hook: JsonObject, events: string[]): void {
  for (const event of events) {
    const current = hookEntries(settings, event);
    const remaining = current.entries.filter(entry => !same(entry, hook));
    if (remaining.length > 0) current.hooks[event] = remaining;
    else delete current.hooks[event];
    if (Object.keys(current.hooks).length > 0) settings.hooks = current.hooks;
    else delete settings.hooks;
  }
}

function readSettings(path: string): { exists: boolean; value: JsonObject; raw: string } {
  if (!existsSync(path)) return { exists: false, value: {}, raw: "" };
  try {
    const raw = readFileSync(path, "utf8");
    return { exists: true, value: object(JSON.parse(stripUtf8Bom(raw)), "Claude settings"), raw };
  } catch (error) {
    throw new Error(`Cannot read Claude settings ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function desired(config: AppConfig): ClaudeIntegrationJournal["installed"] {
  const availableModels = preferredClaudeGatewayModelIds(config);
  return {
    settings: {
      model: availableModels[0],
      availableModels,
      enforceAvailableModels: true,
    },
    env: {
      ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
      ANTHROPIC_AUTH_TOKEN: "codex-chatgpt-web-local",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CODEX_CHATGPT_WEB_CONTROL_TOKEN: config.controlToken,
    },
    hook: {
      hooks: [{
        type: "http",
        url: `http://${config.host}:${config.port}/v1/messages/steering`,
        timeout: 5,
        headers: { Authorization: "Bearer $CODEX_CHATGPT_WEB_CONTROL_TOKEN" },
        allowedEnvVars: ["CODEX_CHATGPT_WEB_CONTROL_TOKEN"],
      }],
    },
    hookEvents: [...CLAUDE_STEERING_HOOK_EVENTS],
  };
}

function snapshot(path: string): FileSnapshot {
  return existsSync(path) ? { path, exists: true, data: readFileSync(path) } : { path, exists: false };
}

function restoreSnapshot(file: FileSnapshot): void {
  if (file.exists) atomicWriteFile(file.path, file.data!);
  else rmSync(file.path, { force: true });
}

function writeWithCompensation(
  settingsPath: string,
  settings: JsonObject,
  journal: ClaudeIntegrationJournal,
  original: string,
): void {
  const files = [snapshot(settingsPath), snapshot(getClaudeIntegrationJournalPath())];
  try {
    atomicWriteFile(settingsPath, preserveUtf8Bom(`${JSON.stringify(settings, null, 2)}\n`, original));
    atomicWriteFile(getClaudeIntegrationJournalPath(), `${JSON.stringify(journal, null, 2)}\n`);
  } catch (error) {
    const failures: string[] = [];
    for (const file of files.reverse()) {
      try { restoreSnapshot(file); } catch (caught) { failures.push(`${file.path}: ${String(caught)}`); }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(failures.length > 0 ? `${primary}; Claude settings rollback failed: ${failures.join("; ")}` : primary);
  }
}

function readJournal(): ClaudeIntegrationJournal | undefined {
  const path = getClaudeIntegrationJournalPath();
  if (!existsSync(path)) return undefined;
  const value = object(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))), "Claude integration journal") as unknown as ClaudeIntegrationJournal;
  if (value.version !== 1 || typeof value.settingsPath !== "string" || !value.installed || !value.previous) {
    throw new Error(`Unsupported Claude integration journal: ${path}`);
  }
  return value;
}

function assertJournalPath(journal: ClaudeIntegrationJournal, path: string): void {
  const identity = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (identity(journal.settingsPath) !== identity(path)) {
    throw new Error(`Claude integration journal belongs to ${journal.settingsPath}, not ${path}`);
  }
}

function assertInstalled(settings: JsonObject, journal: ClaudeIntegrationJournal): void {
  const env = settingsEnv(settings);
  const selectedModel = selectedAvailableModel(settings, journal.installed.settings);
  for (const [key, value] of Object.entries(journal.installed.settings)) {
    if (key === "model" && selectedModel) continue;
    if (!same(settings[key], value)) throw new Error(`Claude ${key} changed after setup`);
  }
  for (const [key, value] of Object.entries(journal.installed.env)) {
    if (!same(env[key], value)) throw new Error(`Claude env.${key} changed after setup`);
  }
  if (journal.installed.hook
    && !hasHook(settings, journal.installed.hook, managedHookEvents(journal.installed))) {
    throw new Error("Claude steering hooks changed after setup");
  }
}

function previousValues(
  current: JsonObject,
  installed: JsonObject,
  existingInstalled?: JsonObject,
  existingPrevious?: Record<string, PreviousValue>,
): Record<string, PreviousValue> {
  return Object.fromEntries(Object.keys(installed).map(key => [
    key,
    existingInstalled && existingPrevious && same(current[key], existingInstalled[key])
      ? existingPrevious[key] ?? capture(current, key)
      : capture(current, key),
  ]));
}

export function getClaudeSettingsPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(resolve(expandUserPath(configured || join(homedir(), ".claude"))), "settings.json");
}

export function getClaudeIntegrationJournalPath(): string {
  return join(getConfigDir(), "claude", "integration-journal.json");
}

export function preflightClaudeIntegration(
  _config: AppConfig,
  options: InstallClaudeIntegrationOptions = {},
): void {
  const path = getClaudeSettingsPath();
  const current = readSettings(path);
  settingsEnv(current.value);
  const journal = readJournal();
  if (!journal) return;
  assertJournalPath(journal, path);
  if (!current.exists && options.replaceExistingRoute !== true) throw new Error(`Claude settings are missing: ${path}`);
  if (current.exists && options.replaceExistingRoute !== true) assertInstalled(current.value, journal);
}

export function installClaudeIntegration(
  config: AppConfig,
  options: InstallClaudeIntegrationOptions = {},
): ClaudeIntegrationJournal {
  const settingsPath = getClaudeSettingsPath();
  const current = readSettings(settingsPath);
  const currentEnvPresent = Object.hasOwn(current.value, "env");
  const currentEnv = settingsEnv(current.value);
  const existing = readJournal();
  if (existing) assertJournalPath(existing, settingsPath);
  if (existing && !current.exists && options.replaceExistingRoute !== true) {
    throw new Error(`Claude settings are missing: ${settingsPath}`);
  }
  if (existing && options.replaceExistingRoute !== true) assertInstalled(current.value, existing);

  const installed = desired(config);
  const selectedModel = selectedAvailableModel(current.value, installed.settings);
  if (selectedModel) installed.settings.model = selectedModel;
  const previous = {
    settings: previousValues(current.value, installed.settings, existing?.installed.settings, existing?.previous.settings),
    env: previousValues(currentEnv, installed.env, existing?.installed.env, existing?.previous.env),
  };
  Object.assign(current.value, installed.settings);
  Object.assign(currentEnv, installed.env);
  current.value.env = currentEnv;
  if (existing?.installed.hook) {
    removeHook(current.value, existing.installed.hook, addedHookEvents(existing.installed));
  }
  installed.hookEventsAdded = installed.hook
    ? addHook(current.value, installed.hook, managedHookEvents(installed))
    : [];
  installed.hookAdded = installed.hookEventsAdded.length > 0;
  const journal: ClaudeIntegrationJournal = {
    version: 1,
    settingsPath,
    settingsExisted: existing?.settingsExisted ?? current.exists,
    previousEnvPresent: existing?.previousEnvPresent ?? currentEnvPresent,
    installed,
    previous,
  };
  writeWithCompensation(settingsPath, current.value, journal, current.raw);
  return journal;
}

export function uninstallClaudeIntegration(): { changed: boolean } {
  const journal = readJournal();
  if (!journal) return { changed: false };
  const current = readSettings(journal.settingsPath);
  if (!current.exists) throw new Error(`Claude settings are missing: ${journal.settingsPath}`);
  assertInstalled(current.value, journal);
  const env = settingsEnv(current.value);
  if (journal.installed.hook) {
    removeHook(current.value, journal.installed.hook, addedHookEvents(journal.installed));
  }
  for (const [key, previous] of Object.entries(journal.previous.settings)) restore(current.value, key, previous);
  for (const [key, previous] of Object.entries(journal.previous.env)) restore(env, key, previous);
  if (Object.keys(env).length > 0 || journal.previousEnvPresent) current.value.env = env;
  else delete current.value.env;

  const files = [snapshot(journal.settingsPath), snapshot(getClaudeIntegrationJournalPath())];
  try {
    if (!journal.settingsExisted && Object.keys(current.value).length === 0) rmSync(journal.settingsPath, { force: true });
    else atomicWriteFile(
      journal.settingsPath,
      preserveUtf8Bom(`${JSON.stringify(current.value, null, 2)}\n`, current.raw),
    );
    rmSync(getClaudeIntegrationJournalPath(), { force: true });
  } catch (error) {
    for (const file of files.reverse()) restoreSnapshot(file);
    throw error;
  }
  return { changed: true };
}
