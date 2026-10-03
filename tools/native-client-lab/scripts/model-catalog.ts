#!/usr/bin/env bun
/**
 * Build the one-row native Codex catalog used by this lab.
 *
 * The augmentation itself is deliberately imported from the checked-out Astra6 source tree;
 * this file only pins the account capability and then removes every row except GPT-6 Pro. That
 * prevents Codex's title helper or picker from selecting a native/Luna/High fallback.
 */
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const TARGET = "chatgpt-web/gpt-6-pro";
import { DEFAULT_SOURCE_ROOT, DEFAULT_CODEX_PATH, nativeInvocation } from "../src/launch-args.mjs";
const DEFAULT_SOURCE = DEFAULT_SOURCE_ROOT;
const DEFAULT_CODEX = DEFAULT_CODEX_PATH;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

function boolArg(name: string, fallback: boolean): boolean {
  const value = arg(name);
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function bundledCatalog(codexPath: string): unknown {
  const invocation = nativeInvocation(codexPath, ["debug", "models", "--bundled"], "codex");
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI_|ANTHROPIC_|CLAUDE_|AWS_|AZURE_|GOOGLE_|GEMINI_)/.test(key))),
  });
  if (result.error) throw new Error(`Codex bundled catalog probe failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Codex bundled catalog probe failed: ${(result.stderr || "").trim() || `exit ${result.status}`}`);
  return JSON.parse(result.stdout);
}

const sourceRoot = resolve(arg("--source-root", process.env.ASTRA6_SOURCE_ROOT || DEFAULT_SOURCE)!);
const output = resolve(required(arg("--output"), "--output"));
const codexPath = resolve(arg("--codex-path", process.env.ASTRA6_CODEX_PATH || DEFAULT_CODEX)!);
const sourceCatalogPath = arg("--source-catalog");
const sourceModule = await import(pathToFileURL(join(sourceRoot, "src", "model-catalog.ts")).href);
const configModule = await import(pathToFileURL(join(sourceRoot, "src", "config.ts")).href);
const native = sourceCatalogPath ? JSON.parse(readFileSync(resolve(sourceCatalogPath), "utf8")) : bundledCatalog(codexPath);
const config = configModule.defaultConfig("full");
config.proAvailable = boolArg("--pro-available", true);
config.solAvailable = boolArg("--sol-available", true);
config.extraHighAvailable = boolArg("--extra-high-available", false);
config.experimentalBiggerContext = boolArg("--bigger-context", false);
config.experimentalNoAutoCompact = boolArg("--no-auto-compact", false);
config.subagentProtocol = (arg("--subagent-protocol", "native") as "native" | "compatibility-v1");
if (config.subagentProtocol !== "native" && config.subagentProtocol !== "compatibility-v1") {
  throw new Error("--subagent-protocol must be native or compatibility-v1");
}
config.browserInteractionMode = "automatic";
config.useEnhancedWebSessionMode = boolArg("--enhanced-web", true);
config.useEnhancedOutputTunnel = boolArg("--enhanced-output", true);
const augmented = sourceModule.augmentNativeModelCatalog(native, config);
const rows = Array.isArray(augmented.models) ? augmented.models.filter((model: any) => model?.slug === TARGET) : [];
if (rows.length !== 1) throw new Error(`Source model-catalog.ts did not produce exactly one ${TARGET} row`);
const row = rows[0];
if (row.default_reasoning_level !== "max"
  || JSON.stringify(row.supported_reasoning_levels?.map((level: any) => level?.effort)) !== JSON.stringify(["max"])) {
  throw new Error(`${TARGET} row is not fixed to max effort`);
}
// This lab intentionally runs with empty MCP/plugins. Do not advertise deferred tool search when
// there is no tool catalog to return; direct native exec/apply_patch capabilities remain intact.
row.supports_search_tool = false;
const catalog = {
  ...augmented,
  models: [row],
  _astra6: {
    route: TARGET,
    effort: "max",
    sourceRoot,
    sourceModule: "src/model-catalog.ts",
    generatedAt: new Date().toISOString(),
    sourceCatalogSha256: createHash("sha256").update(JSON.stringify(native)).digest("hex"),
  },
};
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
try { chmodSync(output, 0o600); } catch {}
process.stdout.write(`MODEL_CATALOG_OK ${output} rows=1 model=${TARGET} effort=max\n`);
