import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, stripUtf8Bom, type AppConfig } from "./config";
import { augmentNativeModelCatalog } from "./model-catalog";
import { findTopLevelAssignment, firstTableIndex, insertDocumentLine, parseDocument,
  removeDocumentLine, renderDocument } from "./codex-integration-toml";
import { getCodexModelsCachePath, sha256, writeIntegrationState,
  type CodexIntegrationJournal, type InstallCodexIntegrationOptions, type PreviousAssignment } from "./codex-integration-shared";

const PROVIDER = "codex-chatgpt-web";
const KEYS = ["model", "model_reasoning_effort", "model_provider", "model_catalog_json"] as const;
type Key = typeof KEYS[number];
export interface WebProviderState {
  fragment: string;
  provider: Record<string, unknown>;
  installed: Record<Key, string>;
  previous: Record<Key, PreviousAssignment>;
  source: Record<string, unknown>;
  catalogHash: string;
}
export function isWebProviderState(value: unknown): value is WebProviderState {
  if (!value || typeof value !== "object") return false;
  const v = value as WebProviderState;
  return typeof v.fragment === "string" && !!v.provider && !!v.source && Array.isArray(v.source.models)
    && typeof v.catalogHash === "string" && /^[a-f0-9]{64}$/.test(v.catalogHash)
    && KEYS.every(key => typeof v.installed?.[key] === "string" && typeof v.previous?.[key]?.present === "boolean"
      && (!v.previous[key].present || typeof v.previous[key].rawLine === "string"));
}
function catalogPath(hash: string): string { return join(getConfigDir(), `codex-web-models-${hash}.json`); }
export function verifyWebProviderCatalog(state: WebProviderState): string {
  const path = catalogPath(state.catalogHash);
  if (state.installed.model_catalog_json !== path || !existsSync(path)
    || sha256(readFileSync(path)) !== state.catalogHash) {
    throw new Error("Managed Web model catalog changed or is missing; refusing to overwrite it");
  }
  return path;
}
export function ownedWebProviderCatalog(state: WebProviderState): string | undefined {
  // After disconnection, changed/missing data is no longer ours to remove.
  try { return verifyWebProviderCatalog(state); } catch { return undefined; }
}
export function verifyWebProvider(text: string, state: WebProviderState): void {
  const catalog = JSON.parse(readFileSync(verifyWebProviderCatalog(state), "utf8")) as {models:Array<Record<string,any>>};
  const parsed = Bun.TOML.parse(stripUtf8Bom(text)) as any;
  if (parsed.profile !== undefined) throw new Error("A Codex profile overrides Web-only mode; remove the profile selection first");
  if (!text.includes(state.fragment) || JSON.stringify(parsed.model_providers?.[PROVIDER]) !== JSON.stringify(state.provider)) {
    throw new Error("Managed Web provider changed; refusing to overwrite it");
  }
  for (const key of ["model_provider", "model_catalog_json"] as const) {
    if (parsed[key] !== state.installed[key]) throw new Error(`Managed Web ${key} changed; refusing to overwrite it`);
  }
  const selected = catalog.models.find(model => model.slug === parsed.model);
  if (!selected || !selected.supported_reasoning_levels.some((level: {effort:string}) => level.effort === parsed.model_reasoning_effort)) {
    throw new Error("Web model or effort changed outside the installed catalog; refusing to overwrite it");
  }
  // Model/effort selection is user-owned within this provider. Route ownership is separate.
}
export function restoreWebProvider(text: string, state: WebProviderState): string {
  verifyWebProvider(text, state);
  const doc = parseDocument(text.replace(state.fragment, ""));
  const current = KEYS.map(key => ({key, value:findTopLevelAssignment(doc.lines,key)}));
  for (const item of current.sort((a,b)=>(b.value.index ?? -1)-(a.value.index ?? -1))) {
    if (item.value.index !== undefined) removeDocumentLine(doc,item.value.index);
  }
  for (const key of [...KEYS].sort((a,b)=>(state.previous[a].index ?? 0)-(state.previous[b].index ?? 0))) {
    const previous = state.previous[key];
    if (previous.present) insertDocumentLine(doc, Math.min(previous.index ?? 0, firstTableIndex(doc.lines)), previous.rawLine!);
  }
  return renderDocument(doc);
}
export function applyWebProvider(text: string, state: WebProviderState): string {
  const parsed = Bun.TOML.parse(stripUtf8Bom(text)) as any;
  if (parsed.profile !== undefined || parsed.model_providers?.[PROVIDER] !== undefined) {
    throw new Error("Codex profile or Web provider name is already configured; refusing to replace user configuration");
  }
  const doc = parseDocument(text);
  state.previous = Object.fromEntries(KEYS.map(key=>[key,findTopLevelAssignment(doc.lines,key)])) as WebProviderState["previous"];
  for (const key of KEYS) {
    const found = findTopLevelAssignment(doc.lines,key);
    const line = `${key} = ${JSON.stringify(state.installed[key])}`;
    if (found.index !== undefined) doc.lines[found.index] = line;
    else insertDocumentLine(doc, firstTableIndex(doc.lines), line);
  }
  return renderDocument(doc) + state.fragment;
}
export function persistProviderRoute(
  journal: CodexIntegrationJournal, text: string, config: AppConfig,
  options: InstallCodexIntegrationOptions, previous?: WebProviderState, selectionText?: string,
): void {
  const mode = options.providerMode ?? (previous ? "web-only" : "mixed");
  if (mode !== "web-only" && mode !== "mixed") throw new Error("Provider mode must be web-only or mixed");
  const removals = [getCodexModelsCachePath()];
  if (previous) removals.push(verifyWebProviderCatalog(previous));
  let writes: Array<{path:string;data:string}> = [];
  if (mode === "web-only") {
    const sourcePath = options.catalogPath ?? getCodexModelsCachePath();
    const source = options.catalogPath || !previous ? (() => {
      if (!existsSync(sourcePath)) throw new Error("A native model catalog is required. Open Codex in mixed mode to populate models_cache.json, or provide --catalog PATH");
      return JSON.parse(stripUtf8Bom(readFileSync(sourcePath,"utf8")));
    })() : previous.source;
    const augmented = augmentNativeModelCatalog(source,config);
    const models = (augmented.models as Array<Record<string,any>>).filter(m=>m.slug.startsWith("chatgpt-web/"));
    const selected = selectionText ? (Bun.TOML.parse(stripUtf8Bom(selectionText)) as any) : {};
    const model = models.find(m=>m.slug === selected.model)
      ?? models.find(m=>m.slug === "chatgpt-web/gpt-5.6-sol") ?? models.find(m=>m.visibility === "list");
    if (!model) throw new Error("Web model catalog has no available model");
    const data = JSON.stringify({models},null,2)+"\n";
    const hash = sha256(data), path = catalogPath(hash);
    if (existsSync(path) && sha256(readFileSync(path)) !== hash) throw new Error("Web model catalog path is occupied by modified data");
    const provider = { name:"ChatGPT Web", base_url:journal.installed.openai_base_url, wire_api:"responses", requires_openai_auth:false, supports_websockets:false };
    const eol = journal.format?.lineEnding ?? "\n";
    const state: WebProviderState = {
      fragment:eol+`[model_providers.${PROVIDER}]`+eol+Object.entries(provider).map(([k,v])=>`${k} = ${JSON.stringify(v)}`).join(eol)+eol,
      provider, source, catalogHash:hash, previous:{} as WebProviderState["previous"],
      installed:{ model:model.slug, model_provider:PROVIDER, model_catalog_json:path,
        model_reasoning_effort:model.supported_reasoning_levels.some((l:any)=>l.effort===selected.model_reasoning_effort)
          ? selected.model_reasoning_effort : model.default_reasoning_level },
    };
    text = applyWebProvider(text,state);
    journal.webProvider = state;
    writes = [{path,data}];
    const index = removals.indexOf(path); if (index >= 0) removals.splice(index,1);
  }
  writeIntegrationState(journal,{path:journal.configPath,data:text},removals,writes);
}
