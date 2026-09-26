import { afterEach, expect, spyOn, test } from "bun:test";
import * as configModule from "../src/config";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { activateCodexIntegration, deactivateCodexIntegration, installCodexIntegration,
  inspectCodexIntegration, preflightCodexIntegration, setCodexSubagentProtocol, uninstallCodexIntegration } from "../src/codex-integration";

const roots: string[] = [];
const priorHome = process.env.CODEX_HOME;
const priorAppHome = process.env.CODEX_CHATGPT_WEB_HOME;
afterEach(() => {
  if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  if (priorAppHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = priorAppHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "web-provider-")); roots.push(root);
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "bridge");
  mkdirSync(process.env.CODEX_HOME);
  const path = join(process.env.CODEX_HOME, "config.toml");
  const original = 'model = "native-model" # native choice\nmodel_reasoning_effort = "high"\n\n[features]\ngoals = true\n';
  writeFileSync(path, original);
  const cache = join(process.env.CODEX_HOME, "models_cache.json");
  writeFileSync(cache, JSON.stringify({models: [{slug:"native-model", display_name:"Native", description:"Native",
    visibility:"list", supported_in_api:true, priority:1, tool_mode:"code_mode_only", shell_type:"shell_command",
    base_instructions:"Fixture instructions", supported_reasoning_levels:[{effort:"high",description:"High"}],
    default_reasoning_level:"high", supports_reasoning_summaries:true, support_verbosity:false,
    default_verbosity:null, apply_patch_tool_type:"freeform", truncation_policy:{mode:"bytes",limit:10000},
    context_window:200000, input_modalities:["text"], multi_agent_version:"v1"}]}));
  return {path, original, cache, config:defaultConfig("full"), read:()=>Bun.TOML.parse(readFileSync(path,"utf8")) as any};
}
test.serial("Web provider separates account auth and only advertises Web models, then restores native config", () => {
  const f = fixture();
  installCodexIntegration(f.config, {providerMode:"web-only"});
  const selected = f.read();
  expect(selected.model_provider).toBe("codex-chatgpt-web");
  expect(selected.model_providers[selected.model_provider].requires_openai_auth).toBe(false);
  expect(selected.model_providers[selected.model_provider].base_url).toBe("http://127.0.0.1:17841/v1");
  expect(selected.model).toStartWith("chatgpt-web/");
  const models = JSON.parse(readFileSync(selected.model_catalog_json,"utf8")).models;
  expect(models.length).toBeGreaterThan(0);
  expect(models.every((m:any)=>m.slug.startsWith("chatgpt-web/") && m.supported_in_api)).toBe(true);
  expect(inspectCodexIntegration().errors).toEqual([]);
  expect(()=>preflightCodexIntegration(f.config)).not.toThrow();
  installCodexIntegration({...f.config,extraHighAvailable:true});
  expect(f.read().model_provider).toBe(selected.model_provider);
  expect(deactivateCodexIntegration().active).toBe(false);
  expect(readFileSync(f.path,"utf8")).toBe(f.original);
  expect(activateCodexIntegration().active).toBe(true);
  expect(f.read().model_provider).toBe(selected.model_provider);
  uninstallCodexIntegration();
  expect(readFileSync(f.path,"utf8")).toBe(f.original);
  expect(existsSync(f.read().model_catalog_json ?? selected.model_catalog_json)).toBe(false);
});
test.serial("switching back to mixed restores native selection and credentials contract", () => {
  const f = fixture();
  installCodexIntegration(f.config,{providerMode:"web-only"});
  installCodexIntegration(f.config,{providerMode:"mixed"});
  expect(f.read().model_provider).toBeUndefined();
  expect(f.read().model).toBe("native-model");
  expect(f.read().model_catalog_json).toBeUndefined();
  expect(f.read().model_providers?.["codex-chatgpt-web"]).toBeUndefined();
  expect(inspectCodexIntegration().errors).toEqual([]);
  uninstallCodexIntegration();
  expect(readFileSync(f.path,"utf8")).toBe(f.original);
});
test.serial("missing model metadata fails before changing config or journal", () => {
  const f = fixture(); rmSync(f.cache);
  expect(()=>installCodexIntegration(f.config,{providerMode:"web-only"})).toThrow(/catalog|model.*cache/i);
  expect(readFileSync(f.path,"utf8")).toBe(f.original);
  expect(inspectCodexIntegration().installed).toBe(false);
});
test.serial("provider collision and active Codex profile fail without overwriting user configuration", () => {
  const f = fixture();
  for (const conflict of ['profile = "work"\n', '[model_providers.codex-chatgpt-web]\nname="User"\n']) {
    const text = conflict.startsWith("profile") ? conflict+f.original : f.original+conflict;
    writeFileSync(f.path,text);
    expect(()=>installCodexIntegration(f.config,{providerMode:"web-only"})).toThrow(/profile|provider/i);
    expect(readFileSync(f.path,"utf8")).toBe(text);
  }
});
test.serial("native model edits and modified catalog remain user-owned even with route replacement", () => {
  const f = fixture();
  installCodexIntegration(f.config,{providerMode:"web-only"});
  const installed = readFileSync(f.path,"utf8"), selected = f.read();
  const changed = installed.replace(`model = ${JSON.stringify(selected.model)}`, 'model = "new-native-choice"');
  writeFileSync(f.path,changed);
  expect(()=>installCodexIntegration(f.config,{providerMode:"mixed",replaceExistingRoute:true})).toThrow(/model/i);
  expect(readFileSync(f.path,"utf8")).toBe(changed);
  writeFileSync(f.path,installed);
  writeFileSync(selected.model_catalog_json,"user data");
  expect(()=>uninstallCodexIntegration()).toThrow(/catalog/i);
  expect(readFileSync(selected.model_catalog_json,"utf8")).toBe("user data");
});
test.serial("Web mode preserves CRLF and restores configuration without a trailing newline", () => {
  const f = fixture();
  const original = f.original.trimEnd().replaceAll("\n","\r\n");
  writeFileSync(f.path,original);
  installCodexIntegration(f.config,{providerMode:"web-only"});
  uninstallCodexIntegration();
  expect(readFileSync(f.path,"utf8")).toBe(original);
});
test.serial("protocol save failure rolls back the Web catalog together with config and journals", () => {
  const f = fixture(); installCodexIntegration(f.config,{providerMode:"web-only"});
  const installed = readFileSync(f.path,"utf8"), selected = f.read();
  const catalog = readFileSync(selected.model_catalog_json,"utf8");
  const save = spyOn(configModule,"saveConfig").mockImplementation(()=>{throw new Error("synthetic save failure");});
  try { expect(()=>setCodexSubagentProtocol(f.config,"native")).toThrow("synthetic save failure"); }
  finally { save.mockRestore(); }
  expect(readFileSync(f.path,"utf8")).toBe(installed);
  expect(existsSync(selected.model_catalog_json)).toBe(true);
  expect(readFileSync(selected.model_catalog_json,"utf8")).toBe(catalog);
  expect(inspectCodexIntegration().errors).toEqual([]);
});
test.serial("reinstall preserves a supported hidden legacy Web model and its effort", () => {
  const f = fixture(); installCodexIntegration(f.config,{providerMode:"web-only"});
  const selected = f.read();
  const catalog = JSON.parse(readFileSync(selected.model_catalog_json,"utf8"));
  const legacy = catalog.models.find((m:any)=>m.visibility==="hide");
  expect(legacy).toBeDefined();
  const text = readFileSync(f.path,"utf8")
    .replace(`model = ${JSON.stringify(selected.model)}`,`model = ${JSON.stringify(legacy.slug)}`)
    .replace(`model_reasoning_effort = ${JSON.stringify(selected.model_reasoning_effort)}`,
      `model_reasoning_effort = ${JSON.stringify(legacy.default_reasoning_level)}`);
  writeFileSync(f.path,text);
  installCodexIntegration(f.config);
  expect(f.read().model).toBe(legacy.slug);
  expect(f.read().model_reasoning_effort).toBe(legacy.default_reasoning_level);
});
for (const changed of [false,true]) {
  test.serial(`disconnected uninstall tolerates ${changed ? "changed" : "missing"} catalog without losing user data`, () => {
    const f = fixture(); installCodexIntegration(f.config,{providerMode:"web-only"});
    const catalog = f.read().model_catalog_json;
    deactivateCodexIntegration();
    if (changed) writeFileSync(catalog,"user-owned data"); else rmSync(catalog);
    expect(()=>activateCodexIntegration()).toThrow(/catalog/i);
    expect(()=>uninstallCodexIntegration()).not.toThrow();
    expect(readFileSync(f.path,"utf8")).toBe(f.original);
    expect(inspectCodexIntegration().installed).toBe(false);
    if (changed) expect(readFileSync(catalog,"utf8")).toBe("user-owned data");
    else expect(existsSync(catalog)).toBe(false);
  });
}
