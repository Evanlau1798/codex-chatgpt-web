import { stdin } from "node:process";
import { basename } from "node:path";
import { loadConfig } from "./config";
import { interruptActiveTurn } from "./service";

export async function runCodexInterruptHook(args: string[]): Promise<void> {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 32 * 1024) throw new Error("Codex Interrupt hook payload is too large");
    chunks.push(buffer);
  }
  let payload: { hook_event_name?: unknown; session_id?: unknown; turn_id?: unknown };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Codex Interrupt hook payload is not valid JSON");
  }
  const threadId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
  if (payload.hook_event_name !== "Interrupt"
    || !/^[A-Za-z0-9_-]{6,128}$/.test(threadId)
    || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
    throw new Error("Codex Interrupt hook payload has no valid session_id or turn_id");
  }
  await interruptActiveTurn(loadConfig(), { threadId, turnId });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--home") {
    const home = args[1];
    if (!home || home.startsWith("--")) throw new Error("--home requires a value");
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    args.splice(0, 2);
  }
  if (args.shift() !== "hook" || args.shift() !== "interrupt") {
    throw new Error("Hook command must be: hook interrupt");
  }
  await runCodexInterruptHook(args);
}

if (/^codex-interrupt-cli\.(?:js|ts)$/.test(basename(process.argv[1] ?? ""))) {
  main().catch(error => {
    process.stderr.write(`codex-chatgpt-web: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
