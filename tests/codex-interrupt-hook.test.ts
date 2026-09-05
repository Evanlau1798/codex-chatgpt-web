import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("installs one narrowly trusted Interrupt hook and restores the exact Codex config", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    "",
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "existing-hook"',
    "",
  ].join("\n");
  const config = { runtimeCommand: ["/opt/Codex Web/runtime/bun", "/opt/Codex Web/app/cli.js"] };
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", config);

  expect(installed.installed.groupIndex).toBe(1);
  expect(installed.installed.stateKey).toBe(`${resolve("/Users/test/.codex/config.toml")}:interrupt:1:0`);
  expect(installed.text).toContain('[[hooks.Interrupt]]');
  expect(installed.text).toContain("timeout = 3");
  expect(installed.text).toContain(`[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`);
  expect(installed.text).toContain(`trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`);
  verifyCodexInterruptHook(installed.text, installed.installed);
  expect(restoreCodexInterruptHook(installed.text, installed.installed)).toBe(original);
  verifyCodexInterruptHookRestored(original);
});

test("trusts the canonical Codex config path before a new config file exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-interrupt-hook-"));
  try {
    const configPath = join(directory, "config.toml");
    const installed = installCodexInterruptHook("", configPath, { runtimeCommand: ["/opt/runtime", "/opt/cli.ts"] });
    expect(installed.installed.stateKey).toBe(
      `${join(realpathSync.native(directory), "config.toml")}:interrupt:0:0`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Interrupt hook command is absolute, quoted, and bound to the exact application home", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["/Applications/Codex Web GPT.app/runtime/bun", "/Applications/Codex Web GPT.app/app/cli.js"] },
    "/Users/test/Application Support/Codex Web GPT",
    "darwin",
  )).toBe(
    "'/Applications/Codex Web GPT.app/runtime/bun' '/Applications/Codex Web GPT.app/app/codex-interrupt-cli.js'"
      + " '--home' '/Users/test/Application Support/Codex Web GPT' 'hook' 'interrupt'",
  );
  const windowsCommand = codexInterruptHookCommand(
    { runtimeCommand: ["C:\\Program Files\\Codex Web GPT\\bun.exe", "C:\\Program Files\\Codex Web GPT\\cli.js"] },
    "C:\\Users\\test\\Codex Web GPT",
    "win32",
    "C:\\Windows",
  );
  expect(windowsCommand).toBe(
    `C:\\Windows\\System32\\cscript.exe //E:JScript //nologo `
      + `"C:\\Program Files\\Codex Web GPT\\codex-interrupt-hook-windows.js" `
      + Buffer.from("C:\\Users\\test\\Codex Web GPT\\config.json", "utf16le").swap16().toString("hex"),
  );
});

test("source-mode Interrupt hooks select the lightweight TypeScript entrypoint", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["/opt/bun", "/workspace/src/cli.ts"] },
    "/tmp/app",
    "linux",
  )).toStartWith("'/opt/bun' '/workspace/src/codex-interrupt-cli.ts'");
});

test("packaged wrapper Interrupt hooks bypass the general CLI on POSIX", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["/opt/Codex Web GPT/bin/codex-chatgpt-web"] },
    "/tmp/app",
    "linux",
  )).toStartWith(
    "'/opt/Codex Web GPT/runtime/bun' '/opt/Codex Web GPT/app/codex-interrupt-cli.js'",
  );
});

test("Interrupt hook trust hash is deterministic and changes with its exact command", () => {
  const first = codexInterruptHookHash("'runtime' 'hook' 'interrupt'");
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(codexInterruptHookHash("'runtime' 'hook' 'interrupt'")).toBe(first);
  expect(codexInterruptHookHash("'other-runtime' 'hook' 'interrupt'")).not.toBe(first);
});

test("refuses to remove a modified or duplicated managed hook", () => {
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(
    original,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime", "/opt/cli.ts"] },
  );
  const modified = installed.text.replace("timeout = 3", "timeout = 2");
  expect(() => restoreCodexInterruptHook(modified, installed.installed)).toThrow("changed after setup");
  const reordered = [
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "new-earlier-hook"',
    "",
    installed.text,
  ].join("\n");
  expect(() => restoreCodexInterruptHook(reordered, installed.installed)).toThrow("order changed after setup");
  expect(() => installCodexInterruptHook(installed.text, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime", "/opt/cli.ts"] }))
    .toThrow("already contains");
});
