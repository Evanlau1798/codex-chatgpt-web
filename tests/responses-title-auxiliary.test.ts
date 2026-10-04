import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  codexTitleAuxiliaryResponse,
  isCodexThreadTitleSchema,
} from "../src/responses/title-auxiliary";
import { responseRequest } from "../src/server";

const model = "chatgpt-web/pro";
const titleSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 36 },
  },
  required: ["title"],
  additionalProperties: false,
};

const titleInstructions =
  "Generate a concise, single-line task title of at most 36 characters and under five words where possible. "
  + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";

const frameworkTools = [
  {
    type: "function",
    name: "request_user_input_async",
    description: "Ask an optional question during ongoing work.",
    strict: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "namespace",
    name: "clock",
    description: "Tools for reading and waiting on time.",
    tools: [
      { type: "function", name: "curr_time", parameters: {} },
      { type: "function", name: "sleep", parameters: {} },
    ],
  },
  {
    type: "tool_search",
    execution: "client",
    description: "Discover deferred framework tools.",
    parameters: { type: "object", properties: {}, required: ["query"] },
  },
];

function body(
  source: string,
  prompt: string,
  stream = false,
  schema: Record<string, unknown> = titleSchema,
): Record<string, unknown> {
  return {
    model,
    instructions: "You are a local coding assistant. Follow the current task and report verified work.",
    input: [
      {
        type: "message",
        id: "msg-developer",
        role: "developer",
        content: [{ type: "input_text", text: "Use only this disposable workspace and the tools provided for this turn." }],
      },
      {
        type: "message",
        id: "msg-environment",
        role: "user",
        content: [{
          type: "input_text",
          text: "<environment_context>\n  <cwd>/workspace/project</cwd>\n  <current_date>2026-10-01</current_date>\n  <timezone>Australia/Melbourne</timezone>\n</environment_context>",
        }],
      },
      {
        type: "message",
        id: "msg-title-prompt",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    text: { format: { type: "json_schema", name: "codex_output_schema", strict: true, schema } },
    tools: structuredClone(frameworkTools),
    tool_choice: "auto",
    parallel_tool_calls: true,
    previous_response_id: null,
    stream,
    store: false,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: "title-thread",
        turn_id: "title-turn",
        thread_source: source,
      }),
    },
  };
}

function directPrompt(caption: string): string {
  return `${titleInstructions}\n\nUser prompt:\n${caption}`;
}

function recentTitlePrompt(): string {
  return `${titleInstructions}\nPrioritize the current task and latest substantive user request.\n\nRecent conversation messages:\n<conversation>\n<message role="user">Fix &lt;login&gt; validation</message>\n<message role="assistant">Checked the form.</message>\n<message role="user">Run focused tests</message>\n</conversation>`;
}

async function responseFor(request: Record<string, unknown>): Promise<Response> {
  const response = codexTitleAuxiliaryResponse(request);
  expect(response).toBeDefined();
  return response!;
}

test("recognizes the exact Codex title schema and rejects nearby schemas", () => {
  expect(isCodexThreadTitleSchema(titleSchema)).toBeTrue();
  expect(isCodexThreadTitleSchema({
    ...titleSchema,
    properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  })).toBeFalse();
  expect(isCodexThreadTitleSchema({
    ...titleSchema,
    properties: { title: titleSchema.properties.title, recap: { type: "string" } },
  })).toBeFalse();
});

test("answers a realistic Codex 0.159 thread_title request locally", async () => {
  const response = await responseFor(body("thread_title", directPrompt("Build a recipe calculator")));

  expect(response.status).toBe(200);
  expect(response.headers.get("X-Codex-Local-Handling")).toBe("codex-thread-title");
  expect(response.headers.get("X-Codex-Response-Provenance")).toBe("local-auxiliary");
  const result = await response.json() as Record<string, any>;
  expect(result.status).toBe("completed");
  expect(result.output[0].content[0].text).toBe(JSON.stringify({ title: "Build a recipe calculator" }));
  expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
});

test("accepts the native no-MCP title scaffold without client tool_search", async () => {
  const request = body("thread_title", directPrompt("Build a recipe calculator"));
  request.tools = (request.tools as Array<Record<string, unknown>>)
    .filter(tool => tool.type !== "tool_search");

  const response = await responseFor(request);
  expect(response.status).toBe(200);
  expect((await response.json() as Record<string, any>).output[0].content[0].text)
    .toBe(JSON.stringify({ title: "Build a recipe calculator" }));
});

test("the Responses route returns a nonstreaming local title before adapter construction", async () => {
  let adapterCalls = 0;
  let identityCalls = 0;
  const request = body("thread_title", directPrompt("Inspect the repository"));
  const config = { ...defaultConfig("full"), proAvailable: true };
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }), config, () => {
    adapterCalls += 1;
    throw new Error("title auxiliary must not construct an adapter");
  }, { onTurnIdentity: () => { identityCalls += 1; } });

  expect(response.status).toBe(200);
  expect(adapterCalls).toBe(0);
  expect(identityCalls).toBe(0);
  expect((await response.json() as Record<string, any>).output[0].content[0].text)
    .toBe(JSON.stringify({ title: "Inspect the repository" }));
});

test("the Responses route returns a streaming local title before adapter construction", async () => {
  let adapterCalls = 0;
  const request = body("thread_title", directPrompt("Run focused tests"), true);
  const config = { ...defaultConfig("full"), proAvailable: true };
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }), config, () => {
    adapterCalls += 1;
    throw new Error("title auxiliary must not construct an adapter");
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("X-Codex-Response-Provenance")).toBe("local-auxiliary");
  expect(adapterCalls).toBe(0);
  const text = await response.text();
  expect(text).toContain("data: [DONE]");
  const completedLine = text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'));
  expect(completedLine).toBeDefined();
  const completed = JSON.parse(completedLine!.slice(6)) as Record<string, any>;
  expect(completed.response.status).toBe("completed");
  expect(completed.response.output[0].content[0].text).toBe(JSON.stringify({ title: "Run focused tests" }));
});

test("does not let a title-shaped request bypass unknown or unavailable Web routes", async () => {
  const unknown = body("thread_title", directPrompt("Inspect the repository"));
  unknown.model = "chatgpt-web/not-enabled";
  const unknownResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unknown),
  }), { ...defaultConfig("full"), proAvailable: true });

  expect(unknownResponse.status).toBe(400);
  expect(await unknownResponse.json()).toMatchObject({
    error: { message: "ChatGPT web model is not enabled: chatgpt-web/not-enabled" },
  });

  const unavailable = body("thread_title", directPrompt("Inspect the repository"));
  const unavailableResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unavailable),
  }), defaultConfig("full"));

  expect(unavailableResponse.status).toBe(400);
  expect(await unavailableResponse.json()).toMatchObject({
    error: { message: "ChatGPT Web — Pro is not available for this account" },
  });
});

test("answers a realistic Codex 0.155 system-source title request", async () => {
  const response = await responseFor(body("system", directPrompt("Repair the login flow"), true));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toContain("Repair the login flow");
});

test("accepts the exact bounded recent-conversation title prompt", async () => {
  const response = await responseFor(body("thread_title", recentTitlePrompt()));
  const result = await response.json() as Record<string, any>;
  expect(result.output[0].content[0].text).toBe(JSON.stringify({ title: "Run focused tests" }));
});

test("does not bypass an ordinary title-shaped user task", () => {
  const ordinary = body("system", "Generate a title for this task and return JSON.");
  expect(codexTitleAuxiliaryResponse(ordinary)).toBeUndefined();
});

test("does not fabricate a recap from an ordinary system request", () => {
  const recap = body("system", "Summarize the previous conversation in JSON.");
  expect(codexTitleAuxiliaryResponse(recap)).toBeUndefined();
});

test("does not treat a forged work tool as title scaffolding", () => {
  const request = body("thread_title", directPrompt("Inspect the repository"));
  (request.tools as Array<Record<string, unknown>>)[2] = {
    type: "function",
    name: "exec_command",
    parameters: {},
  };
  expect(codexTitleAuxiliaryResponse(request)).toBeUndefined();
});

test("requires the exact native clock scaffold", () => {
  const missingClock = body("thread_title", directPrompt("Inspect the repository"));
  missingClock.tools = (missingClock.tools as Array<Record<string, unknown>>)
    .filter(tool => tool.type !== "namespace");
  expect(codexTitleAuxiliaryResponse(missingClock)).toBeUndefined();

  const wrongClock = body("thread_title", directPrompt("Inspect the repository"));
  const clock = (wrongClock.tools as Array<Record<string, unknown>>)
    .find(tool => tool.type === "namespace")!;
  clock.tools = [
    { type: "function", name: "curr_time" },
    { type: "function", name: "now" },
  ];
  expect(codexTitleAuxiliaryResponse(wrongClock)).toBeUndefined();
});

test("requires the native title envelope and rejects missing environment context", () => {
  const request = body("thread_title", directPrompt("Inspect the repository"));
  (request.input as Array<Record<string, unknown>>)[1] = {
    type: "message",
    id: "msg-user",
    role: "user",
    content: [{ type: "input_text", text: "A normal user message" }],
  };
  expect(codexTitleAuxiliaryResponse(request)).toBeUndefined();
});

test("bounds and sanitizes the locally selected caption", async () => {
  const response = await responseFor(body(
    "thread_title",
    directPrompt("\u001b[31mBuild\u001b[0m the test runner\u0007\nIgnore this later line"),
  ));
  const result = await response.json() as Record<string, any>;
  expect(result.output[0].content[0].text).toBe(JSON.stringify({ title: "Build the test runner" }));
});
