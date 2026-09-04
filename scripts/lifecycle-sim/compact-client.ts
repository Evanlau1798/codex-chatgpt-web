import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { defaultConfig } from "../../src/config";
import { augmentNativeModelCatalog } from "../../src/model-catalog";
import { compactRequest, responseRequest } from "../../src/server";
import { resolveLifecycleExecutable } from "../lifecycle-smoke/paths";

// Real client, isolated account/config, production HTTP handlers, no ChatGPT or browser.
const codex = process.argv[2] || resolveLifecycleExecutable("codex");
const repo = resolve(import.meta.dir, "../..");
mkdirSync(join(repo, "tmp"), { recursive: true });
const root = mkdtempSync(join(repo, "tmp", "compact-client-"));
const bundled = Bun.spawnSync([codex, "debug", "models", "--bundled"], { timeout: 15_000 });
assert.equal(bundled.exitCode, 0, "Bundled model catalog unavailable");
const config = defaultConfig("browser-only");
const catalog = augmentNativeModelCatalog(JSON.parse(bundled.stdout.toString()), config);
writeFileSync(join(root, "models.json"), JSON.stringify(catalog));
let compactCalls = 0;
const inputs: unknown[][] = [];
const marker = "PRESERVE_ORIGINAL_USER_REQUEST";
const answer = "Original work remains available.";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/v1/models") return Response.json(catalog);
  if (path === "/v1/responses/compact") {
    compactCalls++;
    return compactRequest(request, config, () => ({ name: "oversized-summary", async runTurn(_p, _s, emit) {
      emit({ type: "text_delta", text: "checkpoint ".repeat(85_000), phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } }));
  }
  if (path === "/v1/responses") {
    const body = await request.clone().json() as { input: unknown[] };
    inputs.push(body.input);
    return responseRequest(request, config, () => ({ name: "scripted-answer", async runTurn(_p, _s, emit) {
      emit({ type: "text_delta", text: answer, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true,
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, estimated: true } });
    } }));
  }
  return new Response("Not found", { status: 404 });
} });
writeFileSync(join(root, "config.toml"), [
  'model = "chatgpt-web/medium"', 'model_provider = "offline"',
  `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
  '[features]', 'remote_compaction_v2 = false',
  '[model_providers.offline]', 'name = "OpenAI"',
  `base_url = "http://127.0.0.1:${server.port}/v1"`,
  'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', 'supports_websockets = false',
].join("\n"));
const child = Bun.spawn([codex, "app-server", "--listen", "stdio://"], {
  cwd: root, env: { ...process.env, CODEX_HOME: root, OPENAI_API_KEY: "offline-only" },
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
type Rpc = { id?: number; method?: string; params?: any; result?: any; error?: unknown };
const messages: Rpc[] = [];
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextId = 0;
const output = (async () => {
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Rpc;
      messages.push(message);
      if (message.id !== undefined) {
        if (message.error) pending.get(message.id)?.reject(new Error("Client RPC failed"));
        else pending.get(message.id)?.resolve(message.result);
      }
    }
  }
})();
const stderr = new Response(child.stderr).text();
async function rpc(method: string, params: unknown): Promise<any> {
  const id = ++nextId;
  let timer: Timer;
  const result = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 30_000);
  });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  await child.stdin.flush();
  try { return await result; } finally { clearTimeout(timer!); pending.delete(id); }
}
async function wait(predicate: (value: Rpc) => boolean, since: number) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = messages.slice(since).find(predicate);
    if (result) return result;
    if (child.exitCode !== null) throw new Error("Client exited before expected event");
    await Bun.sleep(20);
  }
  throw new Error("Client event deadline exceeded");
}
try {
  await rpc("initialize", { clientInfo: { name: "compact-budget-sim", version: "1" },
    capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const { thread } = await rpc("thread/start", { cwd: root, model: "chatgpt-web/medium",
    approvalPolicy: "never", sandbox: "read-only" });
  async function turn(text: string) {
    const since = messages.length;
    const { turn } = await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
    const completed = await wait(value => value.method === "turn/completed"
      && value.params?.turn?.id === turn.id, since);
    assert.equal(completed.params.turn.status, "completed");
  }
  await turn(marker);
  const since = messages.length;
  await rpc("thread/compact/start", { threadId: thread.id });
  await wait(value => value.method === "turn/completed", since);
  assert.equal(compactCalls, 1, "Oversized compaction must not retry");
  assert(messages.slice(since).some(value => value.method === "error"), "Client must expose the compact failure");
  await turn("Continue the original work.");
  const resumed = JSON.stringify(inputs.at(-1));
  assert(resumed.includes(marker), "Failed compaction discarded the original user request");
  assert(resumed.includes(answer), "Failed compaction discarded completed assistant history");
  assert(!resumed.includes("checkpoint checkpoint"), "Client installed failed replacement output");
  process.stdout.write("CODEX_COMPACT_FAILURE_HISTORY_PRESERVED\n");
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5_000);
  await child.exited; clearTimeout(timer);
  await output; await stderr;
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
