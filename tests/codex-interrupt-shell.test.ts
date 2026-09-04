import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexInterruptHookCommand } from "../src/codex-interrupt-hook";

test.skipIf(process.platform !== "win32")("Interrupt hook preserves stdin and exact arguments through both Windows hook shells", async () => {
  const root = mkdtempSync(join(tmpdir(), "hook shell ' $ % spaces-"));
  const script = join(root, "hook.cjs");
  const input = JSON.stringify({ hook_event_name: "Interrupt", session_id: "thread_test", turn_id: "turn_test" });
  writeFileSync(script, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: require("node:fs").readFileSync(0, "utf8") }));');
  copyFileSync(process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe", join(root, "powershell.exe"));
  const command = codexInterruptHookCommand({ runtimeCommand: [process.execPath, script] }, root);
  try {
    for (const shell of ["cmd", "powershell"]) {
      const child = spawn(shell === "cmd" ? process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe"
        : join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        shell === "cmd" ? ["/d", "/s", "/c", `"${command}"`] : ["-NoProfile", "-NonInteractive", "-Command", command],
        { cwd: root, windowsHide: true, windowsVerbatimArguments: shell === "cmd", stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.resume();
      child.stdin.end(input);
      const timer = setTimeout(() => child.kill(), 10_000);
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }).finally(() => clearTimeout(timer));
      expect({ shell, status }).toEqual({ shell, status: 0 });
      expect(JSON.parse(output)).toEqual({ args: ["--home", root, "hook", "interrupt"], input });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
