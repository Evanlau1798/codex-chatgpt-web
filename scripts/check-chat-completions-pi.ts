import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { createChatCompletionExecutor, activeChatCompletionTurns } from "../src/chat-completions/runtime";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatCompletionError } from "../src/chat-completions/contract";

/** Real unmodified pi CLI, production HTTP/compiler/output/runtime with a scripted model worker.
 * Offline protocol/integration proof, not logged-in ChatGPT inference or Windows release acceptance.
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !arg.startsWith("--pi=") && !arg.startsWith("--node="))) throw new Error("Use --pi=<installed pi cli.js> --node=<installed Node executable>");
  const pi = resolve(args.find(arg => arg.startsWith("--pi="))?.slice(5) ?? "");
  const node = resolve(args.find(arg => arg.startsWith("--node="))?.slice(7) ?? "");
  if (!existsSync(pi) || !existsSync(node) || !args.length) throw new Error("Supply existing pi and Node executables; this script does not install clients");
  const temporary = mkdtempSync(join(tmpdir(), "chat-pi-"));
  const agentDir = join(temporary, "agent"); const work = join(temporary, "work");
  mkdirSync(agentDir); mkdirSync(work);
  const key = randomBytes(32).toString("base64url");
  const oldKey = process.env.CODEX_CHATGPT_WEB_API_KEY; const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_API_KEY = key; process.env.CODEX_CHATGPT_WEB_HOME = join(temporary, "service");
  const config = { ...defaultConfig(), port: 0 };
  const report: Record<string, unknown> = { evidence: "real-pi-offline-scripted-worker", platform: process.platform,
    bun: Bun.version, nodeVersion: Bun.spawnSync([node, "--version"]).stdout.toString().trim(),
    worktreeDirty: Bun.spawnSync(["git", "diff", "--quiet"]).exitCode !== 0, commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(), cases: [] };
  const results = report.cases as Array<Record<string, unknown>>;
  let mode: "tools" | "error" | "cancel" = "tools";
  let calls = 0; let toolResults = 0; let cancellationObserved = false;
  let cancelStarted!: () => void;
  const cancelReady = new Promise<void>(r => { cancelStarted = r; });
  const safety = new ChatGptAccountSafety(join(temporary, "safety.json"));
  const executor = createChatCompletionExecutor({ safety, worker: provider => {
    if (provider.chatgptWeb?.localToolsEnabled !== false) throw new Error("Unexpected local tool authority");
    return { async run(turn: BrowserTurn) {
      calls++;
      if (turn.nativeConnector || turn.conversationKey || turn.retainConversation || turn.capabilities.localToolsEnabled) throw new Error("Unexpected native or retained capability");
      const prepared = await turn.prepare(); prepared.release();
      const payload = JSON.parse(prepared.text.slice(prepared.text.indexOf('{"messages"')));
      if (mode === "error") throw new ChatCompletionError("Synthetic model failure", 502, "model_protocol_error");
      if (mode === "cancel") {
        cancelStarted();
        await new Promise<void>(resolve => {
          const done = () => { cancellationObserved = true; resolve(); };
          if (turn.abortSignal?.aborted) done(); else turn.abortSignal?.addEventListener("abort", done, { once: true });
        });
        turn.abortSignal!.throwIfAborted(); return "unreachable";
      }
      const historyResults = payload.messages.filter((message: { role: string }) => message.role === "tool");
      toolResults = Math.max(toolResults, historyResults.length);
      let answer: string;
      if (historyResults.length === 0) answer = JSON.stringify({ content: null, tool_calls: [{ name: "read", arguments: { path: "input.txt" } }] });
      else if (historyResults.length === 1) {
        if (!historyResults[0].content.includes("INERT_PI_FIXTURE")) throw new Error("pi did not return the read result");
        answer = JSON.stringify({ content: null, tool_calls: [{ name: "write", arguments: { path: "result.txt", content: "PI_TOOL_LOOP_OK\n" } }] });
      } else answer = JSON.stringify({ content: "PI_TOOL_LOOP_OK", tool_calls: [] });
      turn.onTextDelta(answer); return answer;
    } };
  } });
  const server = startServer(config, { chatCompletionExecutor: executor });
  const env: Record<string, string> = {
    PATH: `${dirname(node)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    HOME: temporary, USERPROFILE: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", CODEX_CHATGPT_WEB_API_KEY: key,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { enhanced: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "$CODEX_CHATGPT_WEB_API_KEY", authHeader: true,
    models: [{ id: "chatgpt-web/high", name: "Enhanced offline fixture", reasoning: false, input: ["text"],
      contextWindow: 80000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsReasoningEffort: false, supportsDeveloperRole: true,
        supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens" } }],
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
  writeFileSync(join(work, "input.txt"), "INERT_PI_FIXTURE\n");
  const flags = ["--offline", "--no-session", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--provider", "enhanced", "--model", "chatgpt-web/high", "--thinking", "off"];
  const runPrint = async (extra: string[]) => {
    const child = Bun.spawn([node, pi, ...flags, "--mode", "json", "--print", ...extra], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      // Only synthetic diagnostics are kept locally; report never embeds requests, keys, paths or transcripts.
      if (err) writeFileSync(join(temporary, "last-stderr.txt"), err);
      return { out, code, err };
    } finally { clearTimeout(timeout); }
  };
  try {
    const version = Bun.spawnSync([node, pi, "--version"], { cwd: work, env });
    report.piVersion = version.stdout.toString().trim();
    const loop = await runPrint(["--tools", "read,write", "Read input.txt, write the fixed fixture result, then finish."]);
    if (loop.code !== 0 || !existsSync(join(work, "result.txt")) || readFileSync(join(work, "result.txt"), "utf8") !== "PI_TOOL_LOOP_OK\n"
      || toolResults !== 2 || calls !== 3 || !loop.out.includes("PI_TOOL_LOOP_OK")) {
      console.error(loop.err); console.error(loop.out.slice(-5000)); throw new Error(`pi tool loop failed: exit=${loop.code}, requests=${calls}, results=${toolResults}`);
    }
    results.push({ case: "two-tool-rounds", status: "PASS", requests: calls, toolResults, resultFileMatched: true, nativeCapabilities: 0 });
    mode = "error"; const before = calls;
    const failure = await runPrint(["--no-tools", "Exercise an intentional offline model error."]);
    if (calls !== before + 1 || !failure.out.includes('"stopReason":"error"')) {
      console.error(failure.err); console.error(failure.out.slice(-3000)); throw new Error("pi did not classify the SSE error or attempted retries");
    }
    results.push({ case: "sse-error", status: "PASS", requests: calls - before, clientClassifiedError: true, exitCode: failure.code });
    mode = "cancel";
    const child = Bun.spawn([node, pi, ...flags, "--mode", "rpc", "--no-tools"], { cwd: work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin.write(JSON.stringify({ type: "prompt", message: "Hold the inert offline turn for cancellation." }) + "\n"); child.stdin.flush();
      await Promise.race([cancelReady, new Promise<never>((_, reject) => { cancelTimer = setTimeout(() => reject(new Error("pi cancellation request did not reach runtime")), 15000); })]);
      child.stdin.write('{"type":"abort"}\n'); child.stdin.flush();
      const until = Date.now() + 10000;
      while ((!cancellationObserved || activeChatCompletionTurns() !== 0) && Date.now() < until) await Bun.sleep(20);
      if (!cancellationObserved || activeChatCompletionTurns() !== 0) throw new Error("pi cancellation did not settle the original runtime");
      results.push({ case: "rpc-cancel", status: "PASS", cancellationObserved, activeBrowserTurns: activeChatCompletionTurns() });
    } finally { if (cancelTimer) clearTimeout(cancelTimer); child.stdin.end(); child.kill(); await child.exited; await stdout; await stderr; }
    report.status = "PASS";
  } finally {
    await server.stop(true);
    if (oldKey === undefined) delete process.env.CODEX_CHATGPT_WEB_API_KEY; else process.env.CODEX_CHATGPT_WEB_API_KEY = oldKey;
    if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
    const dest = resolve(import.meta.dir, "../tmp/chat-completions"); mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "pi-result.json"), JSON.stringify(report, null, 2));
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
await main();
