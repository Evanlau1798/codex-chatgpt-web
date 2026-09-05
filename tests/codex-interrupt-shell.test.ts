import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexInterruptHookCommand } from "../src/codex-interrupt-hook";

test.skipIf(process.platform !== "win32")("Interrupt hook reaches the exact authenticated turn through both Windows hook shells", async () => {
  const root = mkdtempSync(join(tmpdir(), "hook shell ' $ % spaces-"));
  const input = JSON.stringify({ hook_event_name: "Interrupt", session_id: "thread_test", turn_id: "turn_test" });
  const token = "a".repeat(40);
  const requests: Array<{ authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    requests.push({ authorization: request.headers.get("authorization"), body: await request.json() });
    return Response.json({ status: "ok", cancelled_http_turns: 1, cancelled_browser_turns: 1 });
  } });
  writeFileSync(join(root, "config.json"), JSON.stringify({ host: "127.0.0.1", port: server.port, controlToken: token }));
  const command = codexInterruptHookCommand(
    { runtimeCommand: [process.execPath, join(import.meta.dir, "../src/cli.ts")] },
    root,
  );
  try {
    for (const shell of ["cmd", "powershell"]) {
      const child = spawn(shell === "cmd" ? process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe"
        : join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        shell === "cmd" ? ["/d", "/s", "/c", `"${command}"`] : ["-NoProfile", "-NonInteractive", "-Command", command],
        { cwd: root, windowsHide: true, windowsVerbatimArguments: shell === "cmd", stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let error = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { error += chunk; });
      child.stdin.end(input);
      const timer = setTimeout(() => child.kill(), 10_000);
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }).finally(() => clearTimeout(timer));
      expect({ shell, status, output, error }).toEqual({ shell, status: 0, output: "", error: "" });
    }
    expect(requests).toEqual([
      { authorization: `Bearer ${token}`, body: { threadId: "thread_test", turnId: "turn_test" } },
      { authorization: `Bearer ${token}`, body: { threadId: "thread_test", turnId: "turn_test" } },
    ]);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
