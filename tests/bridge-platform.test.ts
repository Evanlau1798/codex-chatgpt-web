import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";

async function* completedEvents(chunks = 1): AsyncGenerator<AdapterEvent> {
  for (let index = 0; index < chunks; index++) {
    yield { type: "text_delta", text: `chunk-${index}:` + "x".repeat(2_048) };
  }
  yield { type: "done", endTurn: true };
}

function responseStream(platform: NodeJS.Platform, chunks = 1): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    completedEvents(chunks),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { streamPlatform: platform },
  );
}

test("Responses SSE completes through the Windows push stream", async () => {
  const body = await new Response(responseStream("win32")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("Darwin SSE remains decodable through Bun.serve under sustained chunking", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(responseStream("darwin", 64), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("chunk-63:");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  } finally {
    await server.stop(true);
  }
});

for (const streamPlatform of ["win32", "darwin"] as const) {
  test(`REG-02: response.created is nonterminal and content-free (${streamPlatform})`, async () => {
    const content = deferred<void>();
    const finish = deferred<void>();
    const created = deferred<void>();
    const delta = deferred<void>();
    let firstOutputs = 0;
    let completedResponses = 0;
    const terminals: string[] = [];
    async function* events(): AsyncGenerator<AdapterEvent> {
      await content.promise;
      yield { type: "text_delta", text: "PROVIDER_CONTENT" };
      await finish.promise;
      yield { type: "done", endTurn: true };
    }
    const stream = bridgeToResponsesSSE(events(), "chatgpt-web/test", undefined, undefined,
      undefined, undefined, 2_000, {
        streamPlatform,
        onFirstOutput: () => { firstOutputs++; },
        onTerminal: status => { terminals.push(status); },
        onCompletedResponse: () => { completedResponses++; },
      });
    let body = "";
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        body += decoder.decode(chunk, { stream: true });
        if (body.includes("event: response.created\n")) created.resolve();
        if (body.includes("event: response.output_text.delta\n")) delta.resolve();
      }
    })();
    try {
      await Promise.race([created.promise, reading.then(() => { throw new Error("Stream ended before created"); })]);
      const first = JSON.parse(body.split("\n").find(line => line.startsWith("data: "))!.slice(6));
      expect(first).toMatchObject({ type: "response.created", response: { status: "in_progress", output: [] } });
      expect(firstOutputs).toBe(0);
      expect(completedResponses).toBe(0);
      expect(terminals).toEqual([]);
      expect(body).not.toContain("[DONE]");
      content.resolve();
      await Promise.race([delta.promise, reading.then(() => { throw new Error("Stream ended before content"); })]);
      expect(firstOutputs).toBe(1);
      expect(completedResponses).toBe(0);
      expect(terminals).toEqual([]);
      finish.resolve();
      await reading;
      expect(terminals).toEqual(["completed"]);
      expect(completedResponses).toBe(1);
      expect(body.match(/event: response.completed\n/g)).toHaveLength(1);
      expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(body).toEndWith("data: [DONE]\n\n");
    } finally {
      content.resolve();
      finish.resolve();
      await reading;
    }
  });

  test(`REG-06: partial stream failure cannot complete or replay (${streamPlatform})`, async () => {
    let starts = 0;
    let settlements = 0;
    let completions = 0;
    const terminals: string[] = [];
    async function* events(): AsyncGenerator<AdapterEvent> {
      starts++;
      try {
        yield { type: "text_delta", text: "PARTIAL_OUTPUT" };
        throw new Error("fixture transport failure");
      } finally { settlements++; }
    }
    const body = await new Response(bridgeToResponsesSSE(events(), "chatgpt-web/test", undefined,
      undefined, undefined, undefined, 2_000, {
        streamPlatform,
        onTerminal: status => { terminals.push(status); },
        onCompletedResponse: () => { completions++; },
      })).text();
    expect(body).toContain("PARTIAL_OUTPUT");
    expect(body.match(/event: response.failed\n/g)).toHaveLength(1);
    expect(body).not.toContain("event: response.completed\n");
    expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(terminals).toEqual(["failed"]);
    expect(completions).toBe(0);
    expect(starts).toBe(1);
    expect(settlements).toBe(1);
  });
}
