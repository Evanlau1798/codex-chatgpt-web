import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_INTERRUPT_HOOK_END,
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  installCodexInterruptHookCommand,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("preserves hook ownership across native TOML command quoting and inline array serialization", () => {
  const original = 'model = "example"\n\n[mcp_servers.notes]\ncommand = "user-mcp"\n';
  const command = '"C:\\Program Files\\Bridge\\runtime.exe" "hook" "interrupt"';
  const { text, installed } = installCodexInterruptHookCommand(original, "/fixture/config.toml", command);
  const literal = text.replace(JSON.stringify(command), `'${command}'`);
  // Native config/value/write rebuilds an edited Interrupt array inline and drops its old comment.
  const inline = original + `\n[hooks]\nInterrupt = [{ hooks = [{ type = 'command', command = '${command}', timeout = 3 }] }]\n`
    + `[hooks.state.'${installed.stateKey}']\ntrusted_hash = '${installed.trustedHash}'\n${MANAGED_INTERRUPT_HOOK_END}\n`;
  for (const value of [literal, inline, literal.replace(/^#.*interrupt.*\n/gm, "")]) {
    expect(Bun.TOML.parse(value)).toEqual(Bun.TOML.parse(text));
    verifyCodexInterruptHook(value, installed);
    const restored = restoreCodexInterruptHook(value, installed);
    expect(restored).toContain(original);
    expect((Bun.TOML.parse(restored) as any).mcp_servers.notes.command).toBe("user-mcp");
    verifyCodexInterruptHookRestored(restored);
    for (const changed of [value.replace(command, command + " --changed"), value.replace("timeout = 3", "timeout = 9"),
      value.replace(installed.trustedHash, "sha256:changed")]) {
      expect(changed).not.toBe(value);
      expect(() => restoreCodexInterruptHook(changed, installed)).toThrow("changed after setup");
    }
  }
});

test("removes only the owned element of a native inline hook array", () => {
  const original = "[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = 'command'\ncommand = 'user-hook'\n";
  const { installed } = installCodexInterruptHookCommand(original, "/fixture/config.toml", "bridge-hook");
  const text = `[hooks]\nInterrupt = [\n { hooks = [{ type = 'command', command = 'user-hook' }] },\n { hooks = [{ type = 'command', command = 'bridge-hook', timeout = 3 }] },\n]\n`
    + `[hooks.state.'${installed.stateKey}']\ntrusted_hash = '${installed.trustedHash}'\n`
    + "\n[other]\ntext = '''\n[[hooks.Interrupt]]\ncommand = 'example, not a hook'\n'''\n";
  const restored = restoreCodexInterruptHook(text, installed);
  expect((Bun.TOML.parse(restored) as any).hooks.Interrupt).toEqual([{ hooks: [{ type: "command", command: "user-hook" }] }]);
  expect(restored).toContain("text = '''\n[[hooks.Interrupt]]\ncommand = 'example, not a hook'\n'''");
  // A reinstall must append to the existing inline array, not create an invalid array-table.
  const next = installCodexInterruptHookCommand(restored, "/fixture/config.toml", "new-bridge-hook");
  expect(next.installed.groupIndex).toBe(1);
  verifyCodexInterruptHook(next.text, next.installed);
  const again = restoreCodexInterruptHook(next.text, next.installed);
  expect(Bun.TOML.parse(again)).toEqual(Bun.TOML.parse(restored));
});

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
  expect(() => restoreCodexInterruptHook(
    installed.text.replace(MANAGED_INTERRUPT_HOOK_END, `approved = false\n${MANAGED_INTERRUPT_HOOK_END}`),
    installed.installed,
  )).toThrow("changed after setup");
  for (const extension of [
    '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
    '\n[[hooks.Interrupt]]\n',
    `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.unexpected]\nvalue = true\n`,
  ]) {
    expect(() => restoreCodexInterruptHook(
      installed.text.replace(MANAGED_INTERRUPT_HOOK_END, extension + MANAGED_INTERRUPT_HOOK_END),
      installed.installed,
    )).toThrow("changed after setup");
  }
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

test("preserves native TOML editor tables inserted before the trailing hook comment", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHookCommand(
      original.replaceAll("\n", ending),
      "/Users/test/.codex/config.toml",
      "/opt/runtime --home /Users/test hook interrupt",
    );
    // Native config writes normalize line endings and insert tables before the trailing comment.
    const appended = "\n[features]\ngoals = true\n";
    const edited = installed.text.replaceAll("\r\n", "\n")
      .replace(MANAGED_INTERRUPT_HOOK_END, appended + MANAGED_INTERRUPT_HOOK_END);
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + appended);
    verifyCodexInterruptHookRestored(restored);
    expect(() => restoreCodexInterruptHook(
      edited.replace("timeout = 3", "timeout = 2"), installed.installed,
    )).toThrow("changed after setup");
  }
});

test("preserves native model availability state inserted before the hook trust table", () => {
  const configPath = "C:\\Users\\test\\.codex\\config.toml";
  for (const ending of ["\n", "\r\n"]) {
    const original = `model = "gpt-5.6-sol"${ending}`;
    const installed = installCodexInterruptHookCommand(
      original,
      configPath,
      "C:\\runtime\\codex-interrupt-hook.exe",
    );
    const stateTable = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
    const inserted = `[tui.model_availability_nux]${ending}gpt-6-astra = 4${ending}${ending}`;
    const edited = installed.text.replace(stateTable, inserted + stateTable);

    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + inserted);
    const upgraded = installCodexInterruptHookCommand(
      restored,
      configPath,
      "C:\\packaged\\codex-interrupt-hook.exe",
    );
    verifyCodexInterruptHook(upgraded.text, upgraded.installed);
    expect(upgraded.text).toContain(inserted);
  }
});

test("preserves a managed Interrupt hook when Codex moves its trust state before the hook", () => {
  const configPath = "C:\\Users\\test\\.codex\\config.toml";
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHookCommand(
    original,
    configPath,
    "C:\\runtime\\codex-interrupt-hook.exe",
  );
  const fragment = installed.installed.fragment;
  const stateTable = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
  const stateOffset = fragment.indexOf(stateTable);
  const endOffset = fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  const literalState = fragment.slice(stateOffset, endOffset)
    .replace(stateTable, `[hooks.state.'${installed.installed.stateKey}']`);
  const nativeTables = "\n[tui.model_availability_nux]\ngpt-6-astra = 4\n\n[agents]\nmax_depth = 2\n";
  const hookPrefix = fragment.slice(0, stateOffset).replace(/\n$/, "");
  const movedFragment = `${literalState}${nativeTables}${hookPrefix}${fragment.slice(endOffset)}`;
  const moved = installed.text.replace(fragment, movedFragment);

  expect(moved.indexOf(`[hooks.state.'${installed.installed.stateKey}']`))
    .toBeLessThan(moved.indexOf("[[hooks.Interrupt]]"));
  verifyCodexInterruptHook(moved, installed.installed);
  expect(restoreCodexInterruptHook(moved, installed.installed)).toBe(original + nativeTables);
});

test("fails closed when the trust state and end marker both move before the hook", () => {
  const configPath = "C:\\Users\\test\\.codex\\config.toml";
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHookCommand(
    original,
    configPath,
    "C:\\runtime\\codex-interrupt-hook.exe",
  );
  const fragment = installed.installed.fragment;
  const stateTable = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
  const stateOffset = fragment.indexOf(stateTable);
  const endOffset = fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  const movedFragment = `${fragment.slice(stateOffset, endOffset)}${fragment.slice(endOffset, endOffset + MANAGED_INTERRUPT_HOOK_END.length)}${fragment.slice(0, stateOffset)}${fragment.slice(endOffset + MANAGED_INTERRUPT_HOOK_END.length)}`;
  const moved = installed.text.replace(fragment, movedFragment);

  expect(() => verifyCodexInterruptHook(moved, installed.installed))
    .toThrow("Codex interrupt lifecycle hook markers changed");
});

test("fails closed when a reverse-layout hook appears inside a TOML multiline string", () => {
  const configPath = "C:\\Users\\test\\.codex\\config.toml";
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHookCommand(
    original,
    configPath,
    "C:\\runtime\\codex-interrupt-hook.exe",
  );
  const fragment = installed.installed.fragment;
  const stateTable = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
  const stateOffset = fragment.indexOf(stateTable);
  const endOffset = fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  const movedFragment = `${fragment.slice(stateOffset, endOffset)}${fragment.slice(0, stateOffset)}${fragment.slice(endOffset)}`;
  const fake = `notes = '''\n${movedFragment}'''\n`;

  expect(() => verifyCodexInterruptHook(fake, installed.installed))
    .toThrow("Codex interrupt lifecycle hook changed");
});

test("keeps foreign TOML tables inserted between the managed hook and its trust state", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const original = 'model = "example"\n\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "prior-hook"\n'.replaceAll("\n", ending);
    const installed = installCodexInterruptHookCommand(
      original,
      "/Users/test/.codex/config.toml",
      "/opt/runtime --home /Users/test hook interrupt",
    );
    const foreign = '\n[marketplaces.claude-plugins-official]\nsource = "unchanged-user-setting"\n\n[mcp_servers.notes]\ncommand = "notes-server"\n\n'.replaceAll("\n", ending);
    const stateHeader = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
    const edited = installed.text.replace(stateHeader, foreign + stateHeader);
    const outside = installed.text + foreign;
    expect(Bun.TOML.parse(edited.replace(/\r\n?/g, "\n"))).toEqual(Bun.TOML.parse(outside.replace(/\r\n?/g, "\n")));
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(restored).toBe(original + foreign);
    const next = installCodexInterruptHookCommand(
      restored,
      "/Users/test/.codex/config.toml",
      "/opt/new-runtime --home /Users/test hook interrupt",
    );
    verifyCodexInterruptHook(next.text, next.installed);
    expect(restoreCodexInterruptHook(next.text, next.installed)).toBe(restored);
    for (const changed of [
      edited.replace("timeout = 3", "timeout = 2"),
      edited.replace(installed.installed.trustedHash, "sha256:changed"),
      edited + `\n[hooks.state.${JSON.stringify(installed.installed.stateKey)}.extra]\nchanged = true\n`,
      edited + '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-hook"\n',
    ]) {
      expect(() => restoreCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
    }
  }
});

test("preserves ownership when Codex moves trust state before the hook and normalizes boundary newlines", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const original = 'model = "example"\n'.replaceAll("\n", ending);
    const { text, installed } = installCodexInterruptHookCommand(
      original, "/Users/test/.codex/config.toml", "'/opt/runtime' hook interrupt",
    );
    const state = `[hooks.state.${JSON.stringify(installed.stateKey)}]${ending}trusted_hash = ${JSON.stringify(installed.trustedHash)}${ending}`;
    const rewritten = text.replace(state, "").replace("# Managed by codex-chatgpt-web:", state + "# Managed by codex-chatgpt-web:")
      .replace(`timeout = 3${ending}${ending}`, `timeout = 3${ending}`);
    const parse = (value: string) => Bun.TOML.parse(value.replace(/\r\n?/g, "\n"));
    expect(parse(rewritten)).toEqual(parse(text));
    verifyCodexInterruptHook(rewritten, installed);
    const restored = restoreCodexInterruptHook(rewritten, installed);
    expect(parse(restored)).toEqual(parse(original));
    verifyCodexInterruptHookRestored(restored);
    for (const modified of [
      rewritten.replace("timeout = 3", "timeout = 2"),
      rewritten.replace(JSON.stringify(installed.command), JSON.stringify("other-command")),
      rewritten.replace(installed.trustedHash, "sha256:changed"),
      rewritten + state,
      rewritten + `${ending}[hooks.state.${JSON.stringify(installed.stateKey)}.extra]${ending}enabled = true`,
    ]) {
      expect(modified).not.toBe(rewritten);
      expect(() => verifyCodexInterruptHook(modified, installed)).toThrow("changed after setup");
    }
  }
});

test("accepts a literal-quoted trust-state key while preserving another config path's trust entry", () => {
  const original = 'model = "example"\n';
  const installed = installCodexInterruptHookCommand(
    original, "/Users/test/.codex/config.toml", "'/opt/runtime' hook interrupt",
  );
  // Use the Windows key from #443 without depending on this test host's path resolver.
  const stateKey = String.raw`D:\AppData\Codex\UserData\config.toml:interrupt:0:0`;
  const beforeHeader = `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`;
  const journalHeader = `[hooks.state.${JSON.stringify(stateKey)}]`;
  const journal = {
    ...installed.installed,
    stateKey,
    fragment: installed.installed.fragment.replace(beforeHeader, journalHeader),
  };
  const alias = `[hooks.state.'C:\\Users\\test\\.codex\\config.toml:interrupt:0:0']\ntrusted_hash = ${JSON.stringify(journal.trustedHash)}\n`;
  for (const ending of ["\n", "\r\n"]) {
    const edited = installed.text.replace(beforeHeader, `[hooks.state.'${stateKey}']`)
      .replace(MANAGED_INTERRUPT_HOOK_END, alias + MANAGED_INTERRUPT_HOOK_END)
      .replaceAll("\n", ending);
    verifyCodexInterruptHook(edited, journal);
    expect(restoreCodexInterruptHook(edited, journal)).toBe((original + alias).replaceAll("\n", ending));
    for (const changed of [
      edited.replace("timeout = 3", "timeout = 2"),
      edited.replace(journal.trustedHash, "sha256:changed"),
      edited.replace(`[hooks.state.'${stateKey}']`, "[hooks.state.'different-key']"),
      edited + `\n[hooks.state.'${stateKey}'.extra]\nchanged = true\n`,
    ]) {
      expect(() => verifyCodexInterruptHook(changed, journal)).toThrow("changed after setup");
    }
  }
});
