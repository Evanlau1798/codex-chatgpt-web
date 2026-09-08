import { expect, test } from "bun:test";
import {
  installCodexInterruptHook,
  MANAGED_INTERRUPT_HOOK_END,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

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
