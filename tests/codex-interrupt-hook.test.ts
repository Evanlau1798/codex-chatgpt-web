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
    const installed = installCodexInterruptHook("", configPath, { runtimeCommand: ["/opt/runtime"] });
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
    "'/Applications/Codex Web GPT.app/runtime/bun' '/Applications/Codex Web GPT.app/app/cli.js'"
      + " '--home' '/Users/test/Application Support/Codex Web GPT' 'hook' 'interrupt'",
  );
  const windowsCommand = codexInterruptHookCommand(
    { runtimeCommand: ["C:\\Program Files\\Codex Web GPT\\bun.exe", "C:\\Program Files\\Codex Web GPT\\cli.js"] },
    "C:\\Users\\test\\Codex Web GPT",
    "win32",
    "C:\\Windows",
  );
  expect(windowsCommand).toStartWith("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ");
  expect(Buffer.from(windowsCommand.split(" ").at(-1)!, "base64").toString("utf16le")).toBe(
    "& 'C:\\Program Files\\Codex Web GPT\\bun.exe' 'C:\\Program Files\\Codex Web GPT\\cli.js'"
      + " '--home' 'C:\\Users\\test\\Codex Web GPT' 'hook' 'interrupt'; exit $LASTEXITCODE",
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
    { runtimeCommand: ["/opt/runtime"] },
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
  expect(() => installCodexInterruptHook(installed.text, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] }))
    .toThrow("already contains");
});
