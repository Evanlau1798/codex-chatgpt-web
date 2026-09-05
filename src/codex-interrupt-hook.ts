import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";
const INTERRUPT_HOOK_TIMEOUT_SECONDS = 3;

function canonicalJson(value: unknown): unknown {
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

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
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
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    `timeout = ${INTERRUPT_HOOK_TIMEOUT_SECONDS}`,
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
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
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  const first = text.indexOf(installed.fragment);
  if (first < 0 || text.indexOf(installed.fragment, first + installed.fragment.length) >= 0) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (interruptGroupCount(text.slice(0, first)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }
  if (managedMarkerCount(text) !== 1 || !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
}

export function restoreCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): string {
  verifyCodexInterruptHook(text, installed);
  return text.replace(installed.fragment, "");
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
