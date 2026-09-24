import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";
const INTERRUPT_HOOK_TIMEOUT_SECONDS = 3;

function canonicalJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: INTERRUPT_HOOK_TIMEOUT_SECONDS,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function windowsShellArgument(value: string): string {
  if (/["\r\n$`!]/.test(value) || /%[^%]+%/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
  windowsRoot = process.env.SystemRoot ?? process.env.WINDIR,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const runtimeCommand = [...config.runtimeCommand];
  const path = platform === "win32" ? win32 : posix;
  const entry = runtimeCommand[1];
  const wrapper = path.basename(runtimeCommand[0] ?? "").toLowerCase();
  if (runtimeCommand.length === 1
    && path.basename(path.dirname(runtimeCommand[0] ?? "")).toLowerCase() === "bin"
    && (wrapper === "codex-chatgpt-web" || wrapper === "codex-chatgpt-web.cmd")) {
    const root = path.dirname(path.dirname(runtimeCommand[0]));
    runtimeCommand.splice(0, 1,
      path.join(root, "runtime", platform === "win32" ? "bun.exe" : "bun"),
      path.join(root, "app", "codex-interrupt-cli.js"));
  } else if (entry && (path.basename(entry) === "cli.js" || path.basename(entry) === "cli.ts")) {
    runtimeCommand[1] = path.join(path.dirname(entry), `codex-interrupt-cli.${path.extname(entry).slice(1)}`);
  }
  if (platform === "win32") {
    if (!windowsRoot || !win32.isAbsolute(windowsRoot)) {
      throw new Error("Windows system root is unavailable for the Codex interrupt hook");
    }
    const cscript = win32.join(win32.resolve(windowsRoot), "System32", "cscript.exe");
    if (/[\s&|<>^()%!"']/.test(cscript)) {
      throw new Error("Windows Script Host path cannot be represented safely in the Codex interrupt hook");
    }
    const interruptEntry = runtimeCommand[1];
    if (!interruptEntry) throw new Error("Codex interrupt hook runtime entrypoint is unavailable");
    const script = win32.join(win32.dirname(interruptEntry), "codex-interrupt-hook-windows.js");
    const configPath = Buffer.from(win32.join(absoluteHome, "config.json"), "utf16le").swap16().toString("hex");
    return `${cscript} //E:JScript //nologo ${windowsShellArgument(script)} ${configPath}`;
  }
  const args = [...runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groups = parseHookDocument(text).hooks?.Interrupt;
  if (groups !== undefined && !Array.isArray(groups)) throw new Error("Codex Interrupt hooks must be an array");
  const groupIndex = groups?.length ?? 0;
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const trustSection = [
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    `timeout = ${INTERRUPT_HOOK_TIMEOUT_SECONDS}`,
    "",
    trustSection,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  const ast = parseHookAst(text);
  const inline = inlineInterruptArray(ast);
  let installedText = `${text}${fragment}`;
  if (inline) {
    const end = inline.range[1] - 1;
    const last = inline.elements.at(-1);
    const comma = last && !ast.tokens.some(token => token.value === "," && token.range[0] >= last.range[1] && token.range[1] <= end)
      ? "," : "";
    const item = `${comma} { hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 3 }] } `;
    installedText = text.slice(0, end) + item + text.slice(end) + leading + trustSection + trailing;
  }
  return {
    text: installedText,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

type SourceRange = { start: number; end: number };
type HookDocument = { hooks?: { Interrupt?: unknown[]; state?: Record<string, unknown> } };

function inlineInterruptArray(ast: AST.TOMLProgram): AST.TOMLArray | undefined {
  const visit = (value: AST.TOMLContentNode, path: string[]): AST.TOMLArray | undefined => {
    if (path.length === 2 && path[0] === "hooks" && path[1] === "Interrupt" && value.type === "TOMLArray") return value;
    if (value.type === "TOMLInlineTable") {
      for (const entry of value.body) {
        const found = visit(entry.value, [...path, ...getStaticTOMLValue(entry.key)]);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      if (node.resolvedKey.some(part => typeof part !== "string")) continue;
      for (const entry of node.body) {
        const found = visit(entry.value, [...node.resolvedKey as string[], ...getStaticTOMLValue(entry.key)]);
        if (found) return found;
      }
    } else {
      const found = visit(node.value, getStaticTOMLValue(node.key));
      if (found) return found;
    }
  }
  return undefined;
}

function parseHookDocument(text: string): HookDocument {
  return Bun.TOML.parse(text.replace(/\r\n?/g, "\n")) as HookDocument;
}

function parseHookAst(text: string): AST.TOMLProgram {
  // Keep source offsets intact so owned ranges still address the original BOM-prefixed file.
  return parseTOML(text.replace(/^\uFEFF/, " ").replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" });
}

function withoutEmptyHookContainers(document: HookDocument): unknown {
  const result = structuredClone(document);
  const hooks = result.hooks;
  if (hooks) {
    if (hooks.Interrupt?.length === 0) delete hooks.Interrupt;
    if (hooks.state && Object.keys(hooks.state).length === 0) delete hooks.state;
    if (Object.keys(hooks).length === 0) delete result.hooks;
  }
  return canonicalJson(result);
}

function removeRanges(text: string, ranges: SourceRange[]): string {
  for (const { start, end } of [...ranges].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): SourceRange[] {
  const changed = () => new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  let document: HookDocument;
  let ast: AST.TOMLProgram;
  let journalAst: AST.TOMLProgram;
  const expectedGroup = { hooks: [{ type: "command", command: installed.command, timeout: 3 }] };
  const expectedState = { trusted_hash: installed.trustedHash };
  const equal = (left: unknown, right: unknown) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
  try {
    const journal = parseHookDocument(installed.fragment);
    if (!equal(journal.hooks?.Interrupt, [expectedGroup])
      || !equal(journal.hooks?.state, { [installed.stateKey]: expectedState })) throw changed();
    document = parseHookDocument(text);
    // Normalize bare CR without moving offsets; the parser retains every source range and comment.
    ast = parseHookAst(text);
    journalAst = parseHookAst(installed.fragment);
  } catch {
    throw changed();
  }
  const groups = document.hooks?.Interrupt;
  if (!Array.isArray(groups) || !equal(groups[installed.groupIndex], expectedGroup)) {
    if (Array.isArray(groups) && groups.some(group => equal(group, expectedGroup))) {
      throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
    }
    throw changed();
  }
  if (!equal(document.hooks?.state?.[installed.stateKey], expectedState)) throw changed();

  const ranges: SourceRange[] = [];
  // A native config edit may discard comments. Authority comes from the exact journal, command,
  // group index and trust hash; a marker inside a value or duplicate marker is never authority.
  for (const marker of [MANAGED_INTERRUPT_HOOK_START, MANAGED_INTERRUPT_HOOK_END]) {
    const comments = ast.comments.filter(comment => text.slice(...comment.range) === marker);
    if (comments.length > 1 || text.split(marker).length - 1 !== comments.length) {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
    }
    for (const comment of comments) {
      let start = comment.range[0];
      if (marker === MANAGED_INTERRUPT_HOOK_START) {
        const separatorCount = installed.fragment.match(/^(?:\r\n|\n|\r)*/)?.[0].match(/\r\n|\n|\r/g)?.length ?? 0;
        const prefix = new RegExp(`(?:\\r\\n|\\n|\\r){0,${separatorCount}}$`).exec(text.slice(0, start));
        start -= prefix?.[0].length ?? 0;
      }
      ranges.push({ start, end: comment.range[1] });
    }
  }
  const groupPath = ["hooks", "Interrupt", installed.groupIndex];
  const statePath = ["hooks", "state", installed.stateKey];
  const startsWith = (path: (string | number)[], prefix: (string | number)[]) =>
    prefix.every((part, index) => path[index] === part);
  let groupLocated = false;
  let stateLocated = false;
  let groupStart: number | undefined;
  let stateStart: number | undefined;
  const owned = (path: (string | number)[], start: number) => {
    if (startsWith(path, groupPath)) {
      groupLocated = true;
      if (path.length === groupPath.length) groupStart = start;
      return true;
    }
    if (startsWith(path, statePath)) {
      if (path.length !== statePath.length) throw changed();
      stateLocated = true;
      stateStart = start;
      return true;
    }
    return false;
  };
  const removeNode = (node: AST.TOMLNode, siblings?: AST.TOMLNode[]) => {
    let end = node.range[1];
    if (node.type === "TOMLTable") {
      const path = [...node.resolvedKey];
      if (startsWith(path, groupPath)) path[2] = 0;
      const original = journalAst.body[0].body.find(item => item.type === "TOMLTable" && equal(item.resolvedKey, path));
      if (original) {
        const count = installed.fragment.slice(original.range[1]).match(/^(?:\r\n|\n|\r)*/)?.[0].match(/\r\n|\n|\r/g)?.length ?? 0;
        end += new RegExp(`^(?:\\r\\n|\\n|\\r){0,${count}}`).exec(text.slice(end))?.[0].length ?? 0;
      }
    }
    ranges.push({ start: node.range[0], end });
    if (!siblings || siblings.length < 2) return;
    const index = siblings.indexOf(node);
    const left = index > 0 ? siblings[index - 1]!.range[1] : node.range[1];
    const right = index > 0 ? node.range[0] : siblings[index + 1]!.range[0];
    const comma = ast.tokens.find(token => token.value === "," && token.range[0] >= left && token.range[1] <= right);
    if (!comma) throw changed();
    ranges.push({ start: comma.range[0], end: comma.range[1] });
  };
  const visitValue = (value: AST.TOMLContentNode, path: (string | number)[]) => {
    if (value.type === "TOMLInlineTable") {
      for (const entry of value.body) visitEntry(entry, path, value.body);
    } else if (value.type === "TOMLArray") {
      value.elements.forEach((element, index) => {
        const elementPath = [...path, index];
        if (owned(elementPath, element.range[0])) removeNode(element, value.elements);
        else visitValue(element, elementPath);
      });
    }
  };
  const visitEntry = (entry: AST.TOMLKeyValue, prefix: (string | number)[], siblings?: AST.TOMLNode[]) => {
    const path = [...prefix, ...getStaticTOMLValue(entry.key)];
    if (owned(path, entry.range[0])) removeNode(entry, siblings);
    else if (equal(path, ["hooks", "Interrupt"]) && entry.value.type === "TOMLArray" && entry.value.elements.length === 1) {
      if (!owned([...path, 0], entry.value.elements[0]!.range[0])) throw changed();
      removeNode(entry, siblings);
    } else visitValue(entry.value, path);
  };
  for (const node of ast.body[0].body) {
    if (node.type === "TOMLTable") {
      if (owned(node.resolvedKey, node.range[0])) removeNode(node);
      else for (const entry of node.body) visitEntry(entry, node.resolvedKey);
    } else visitEntry(node, []);
  }
  if (!groupLocated || !stateLocated) throw changed();
  if (ast.body[0].body.some(node => node.type === "TOMLTable"
    && node.resolvedKey.length > statePath.length && startsWith(node.resolvedKey, statePath))) {
    throw changed();
  }
  const endMarker = ast.comments.find(comment => text.slice(...comment.range) === MANAGED_INTERRUPT_HOOK_END);
  const groupBoundary = groupStart;
  if (endMarker && groupBoundary !== undefined && ast.body[0].body.some(node => node.type === "TOMLTable"
    && node.resolvedKey[0] === "hooks" && node.resolvedKey[1] === "Interrupt"
    && typeof node.resolvedKey[2] === "number" && node.resolvedKey[2] !== installed.groupIndex
    && node.range[0] > groupBoundary && node.range[0] < endMarker.range[0])) {
    throw changed();
  }
  if (endMarker && groupStart !== undefined && stateStart !== undefined
    && endMarker.range[0] < groupStart && stateStart < groupStart) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  // Keep byte-exact restoration when the owned fragment has not been reformatted.
  const exact = text.indexOf(installed.fragment);
  if (exact >= 0 && text.indexOf(installed.fragment, exact + 1) < 0) {
    ranges.splice(0, ranges.length, { start: exact, end: exact + installed.fragment.length });
  } else {
    for (const range of ranges) {
      const lineStart = Math.max(text.lastIndexOf("\n", range.start - 1), text.lastIndexOf("\r", range.start - 1)) + 1;
      if (/^[ \t]*$/.test(text.slice(lineStart, range.start))) range.start = lineStart;
      const tail = /[\r\n]/.test(text[range.end - 1] ?? "")
        ? null : /^[ \t]*(?:\r\n|\n|\r|$)/.exec(text.slice(range.end));
      if (tail) range.end += tail[0].length;
    }
  }
  const merged: SourceRange[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && (range.start <= previous.end || /^\s*$/.test(text.slice(previous.end, range.start)))) {
      previous.end = Math.max(previous.end, range.end);
    } else merged.push({ ...range });
  }
  const expectedRestored = structuredClone(document);
  expectedRestored.hooks!.Interrupt!.splice(installed.groupIndex, 1);
  delete expectedRestored.hooks!.state![installed.stateKey];
  try {
    if (!equal(withoutEmptyHookContainers(parseHookDocument(removeRanges(text, merged))),
      withoutEmptyHookContainers(expectedRestored))) throw changed();
  } catch { throw changed(); }
  return merged;
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = Bun.TOML.parse(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
