import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { readJsonRequestBody } from "../src/http-body";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { parseRequest } from "../src/responses/parser";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { AdapterEvent } from "../src/types";

// Exercise the native ChatGPT-authenticated wire shape. A custom/API-key provider strips item
// provenance and takes a different recovery path, hiding the same-turn steering regression.
// Model responses and credentials are fixtures; no real account or browser is used.
const codex = resolve(process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000 });
if (bundled.status !== 0) throw new Error(`Could not read bundled models: ${bundled.stderr}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-web-environment-")));
const codexHome = join(root, "codex");
const project = join(root, "project");
const auxiliary = join(root, "auxiliary");
for (const directory of [codexHome, project, auxiliary]) mkdirSync(directory, { recursive: true });
for (const directory of [project, auxiliary]) {
  const initialized = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(`Could not create fixture repository: ${initialized.stderr}`);
}
const config = defaultConfig("browser-only");
config.solAvailable = true;
config.proAvailable = true;
config.subagentProtocol = "compatibility-v1";
const catalog = augmentNativeModelCatalog(JSON.parse(bundled.stdout), config);
const catalogPath = join(root, "models.json");
writeFileSync(catalogPath, JSON.stringify(catalog));
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const accountId = "00000000-0000-4000-8000-000000000001";
writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
  auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: {
    id_token: `${b64({ alg: "none", typ: "JWT" })}.${b64({
      email: "environment-smoke@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus", chatgpt_user_id: "local-fixture", chatgpt_account_id: accountId,
      },
    })}.c2ln`,
    access_token: "local-fixture-not-a-credential", refresh_token: "local-fixture-no-refresh", account_id: accountId,
  },
  last_refresh: new Date().toISOString(),
}), { mode: 0o600 });

const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome, codexHome);
const steps = new Map<string, number>();
const failures: string[] = [];
let childRequests = 0;
let authenticatedSteering = false;
let childStarted!: () => void;
let steeringQueued!: () => void;
const childReady = new Promise<void>(resolve => { childStarted = resolve; });
const steeringReady = new Promise<void>(resolve => { steeringQueued = resolve; });
const namespaces = new Map(["spawn_agent", "send_input", "wait_agent"].map(name => [name, { namespace: "multi_agent_v1", name }]));
type InputItem = Record<string, any>;

function spawnedId(input: InputItem[]): string {
  for (const item of [...input].reverse()) {
    if (item.type !== "function_call_output" || typeof item.output !== "string") continue;
    try {
      const output = JSON.parse(item.output);
      if (typeof output.agent_id === "string") return output.agent_id;
    } catch { /* not the spawn result */ }
  }
  throw new Error("Native spawn did not return a child id");
}

async function* tool(name: string, args: unknown): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: `call_${crypto.randomUUID()}`, name };
  yield { type: "tool_call_delta", arguments: JSON.stringify(args) };
  yield { type: "tool_call_end" };
  yield { type: "done", stopReason: "tool_use", endTurn: false };
}

async function* answer(text: string, ready?: Promise<void>): AsyncGenerator<AdapterEvent> {
  if (ready) await ready;
  yield { type: "text_delta", text, phase: "final_answer" };
  yield { type: "done", stopReason: "stop", endTurn: true };
}

async function* failure(error: Error): AsyncGenerator<AdapterEvent> { throw error; }

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") return Response.json(catalog);
    // The built-in provider probes WebSockets before using the HTTP Responses transport.
    if (request.method !== "POST") return new Response("HTTP fixture only", { status: 426 });
    if (url.pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    let stream: AsyncIterable<AdapterEvent>;
    try {
      const body = await readJsonRequestBody(request) as Record<string, any>;
      const header = request.headers.get("x-codex-turn-metadata");
      if (header) body.client_metadata = { ...body.client_metadata, "x-codex-turn-metadata": header };
      const metadata = JSON.parse(body.client_metadata?.["x-codex-turn-metadata"] ?? "{}");
      const threadId = metadata.thread_id;
      if (typeof threadId !== "string") throw new Error("Native request omitted its thread identity");
      const child = metadata.subagent_kind === "thread_spawn";
      const step = steps.get(threadId) ?? 0;
      steps.set(threadId, step + 1);
      const input = body.input as InputItem[];
      if (child) childRequests += 1;
      const environment = store.resolve(parseRequest(body));
      if (environment.cwd !== project || !environment.roots.includes(auxiliary)) {
        throw new Error("Resolved authority lost the primary or auxiliary workspace");
      }
      if (child && step === 1) {
        const users = input.filter(item => item.type === "message" && item.role === "user");
        if (users.length < 3 || users.some(item => item.internal_chat_message_metadata_passthrough?.turn_id !== metadata.turn_id)) {
          throw new Error("Fixture did not exercise attributed same-turn native steering");
        }
        if (Object.hasOwn(metadata.workspaces ?? {}, auxiliary)) {
          throw new Error("Native metadata now includes auxiliary roots; revise this regression fixture");
        }
        if (!input.some(item => item.type === "message" && item.role === "assistant")) {
          throw new Error("Fixture did not deliver steering after the initial assistant answer");
        }
        authenticatedSteering = true;
      }
      if (child) {
        childStarted();
        stream = answer(step === 0 ? "INITIAL_CHILD_FINAL" : "STEERED_CHILD_FINAL", step === 0 ? steeringReady : undefined);
      } else if (step === 0) {
        stream = tool("spawn_agent", { message: "Return the bounded fixture result.", fork_context: false, model: "chatgpt-web/pro" });
      } else if (step === 1) {
        await childReady;
        stream = tool("send_input", { target: spawnedId(input), message: "Finish with the current result.", interrupt: false });
      } else if (step === 2) {
        steeringQueued();
        stream = tool("wait_agent", { targets: [spawnedId(input)], timeout_ms: 10_000 });
      } else stream = answer("ROOT_DONE");
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      failures.push(cause.message);
      stream = failure(cause);
    }
    return new Response(bridgeToResponsesSSE(stream, "chatgpt-web/pro", namespaces), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
writeFileSync(join(codexHome, "config.toml"), [
  'model="chatgpt-web/pro"', 'model_provider="openai"',
  `model_catalog_json=${JSON.stringify(catalogPath)}`, `openai_base_url="http://127.0.0.1:${server.port}/v1"`,
  '[features]', 'multi_agent=true', 'multi_agent_v2=false', '[agents]', 'max_depth=1',
].join("\n"));
const environment: Record<string, string | undefined> = { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome };
delete environment.OPENAI_API_KEY;
const child = Bun.spawn([
  codex, "exec", "--skip-git-repo-check", "--json", "--dangerously-bypass-approvals-and-sandbox",
  "--add-dir", auxiliary, "--model", "chatgpt-web/pro", "Run the bounded child steering fixture.",
], { cwd: project, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const timeout = setTimeout(() => { childStarted(); steeringQueued(); child.kill(); }, 60_000);
try {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  const childCompleted = stdout.trim().split("\n").map(line => JSON.parse(line)).some(event => (
    event.type === "item.completed" && event.item?.type === "collab_tool_call" && event.item.tool === "wait"
    && Object.values(event.item.agents_states ?? {}).some(state => {
      const agent = state as { status?: string; message?: string };
      return agent.status === "completed" && agent.message === "STEERED_CHILD_FINAL";
    })
  ));
  if (exitCode !== 0 || failures.length > 0 || childRequests !== 2 || !authenticatedSteering
    || !childCompleted) {
    throw new Error(`Native environment smoke failed: exit=${exitCode}; childRequests=${childRequests}; ${failures.join("; ")}\n${stderr.slice(-2000)}`);
  }
  process.stdout.write("NATIVE_CODEX_STEERING_ENVIRONMENT_SMOKE_OK\n");
} finally {
  clearTimeout(timeout);
  childStarted();
  steeringQueued();
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
