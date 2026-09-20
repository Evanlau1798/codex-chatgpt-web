import { expect, test } from "bun:test";
import {
  installCodexInterruptHook,
  MANAGED_INTERRUPT_HOOK_END,
  MANAGED_INTERRUPT_HOOK_START,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("accepts Codex native formatting of an unchanged managed hook", () => {
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(original, "C:\\Users\\test\\.codex\\config.toml", {
    runtimeCommand: ["C:\\runtime\\bun.exe", "G:\\repo\\src\\cli.ts"],
  });
  const unrelatedState = [
    '[hooks.state."plugin:session_start:0:0"]',
    'trusted_hash = "sha256:plugin"',
    "enabled = false",
    "",
  ].join("\n");
  const rewritten = installed.text
    .replace(
      `${MANAGED_INTERRUPT_HOOK_START}\n[[hooks.Interrupt]]\n\n[[hooks.Interrupt.hooks]]`,
      `[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\n${MANAGED_INTERRUPT_HOOK_START}`,
    )
    .replace(
      `[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`,
      `${unrelatedState}[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`,
    )
    .replace(`${MANAGED_INTERRUPT_HOOK_END}\n`, "")
    + '[tui.model_availability_nux]\ngpt-6-astra = 4\n';

  verifyCodexInterruptHook(rewritten, installed.installed);
  const restored = restoreCodexInterruptHook(rewritten, installed.installed);
  const parsed = Bun.TOML.parse(restored) as {
    hooks?: { Interrupt?: unknown; state?: Record<string, unknown> };
    tui?: { model_availability_nux?: Record<string, number> };
  };
  expect(parsed.hooks?.Interrupt).toBeUndefined();
  expect(parsed.hooks?.state?.["plugin:session_start:0:0"]).toEqual({
    trusted_hash: "sha256:plugin",
    enabled: false,
  });
  expect(parsed.tui?.model_availability_nux?.["gpt-6-astra"]).toBe(4);
  verifyCodexInterruptHookRestored(restored);

  for (const changed of [
    rewritten.replace("timeout = 3", "timeout = 2"),
    rewritten.replace(installed.installed.trustedHash, "sha256:changed"),
    rewritten + `\n${MANAGED_INTERRUPT_HOOK_START}\n`,
  ]) {
    expect(() => verifyCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
  }
});

test("restores a hook whose end comment moved before unchanged definitions", () => {
  for (const ending of ["\n", "\r\n"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", {
      runtimeCommand: ["/opt/runtime", "/opt/cli.ts"],
    });
    const mcp = '\n[mcp_servers.node_repl]\ncommand = "my-mcp"\n\n[mcp_servers.node_repl.env]\nMODE = "user-setting"\n';
    const definitions = installed.installed.fragment.replaceAll("\r\n", "\n")
      .replace(`${MANAGED_INTERRUPT_HOOK_END}\n`, "");
    for (const beforeModel of [false, true]) {
      const marker = `${MANAGED_INTERRUPT_HOOK_END}\n`;
      const edited = (beforeModel ? marker + original : original + marker) + mcp + definitions;
      verifyCodexInterruptHook(edited, installed.installed);
      const restored = restoreCodexInterruptHook(edited, installed.installed);
      expect(restored).toBe(original + mcp);
      verifyCodexInterruptHookRestored(restored);

      for (const changed of [
        edited.replace("timeout = 3", "timeout = 2"),
        edited + "approved = false\n",
        edited + '\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "unexpected-command"\n',
        edited + marker,
      ]) {
        expect(() => restoreCodexInterruptHook(changed, installed.installed)).toThrow("changed after setup");
      }
      const markerInsideValue = original + 'description = """\n' + marker + '"""\n' + mcp + definitions;
      expect(() => restoreCodexInterruptHook(markerInsideValue, installed.installed)).toThrow("markers changed after setup");
    }
  }
});
