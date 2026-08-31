import { expect, test } from "bun:test";
import { forwardNativeCodexRequest } from "../src/native-passthrough";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";

test("forwards native Codex requests verbatim to the official backend", async () => {
  const originalBody = Bun.zstdCompressSync(Buffer.from('{"model":"gpt-5.6-sol","stream":true}'));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
      host: "127.0.0.1:17841",
      connection: "keep-alive",
    },
    body: encoded,
  });
  let upstreamUrl = "";
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamUrl = input.url;
    upstreamRequest = input;
    return new Response("data: native\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", connection: "keep-alive" },
    });
  });

  expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(upstreamRequest).toBeDefined();
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstreamRequest!.headers.get("host")).toBeNull();
  expect(upstreamRequest!.headers.get("connection")).toBeNull();
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("connection")).toBeNull();
  expect(await response.text()).toBe("data: native\n\n");
});

test("forwards native Codex compaction requests to the official compact endpoint", async () => {
  const originalBody = Bun.zstdCompressSync(Buffer.from('{"model":"gpt-5.6-sol","input":[]}'));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamUrl = "";
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "responses/compact", async input => {
    upstreamUrl = input.url;
    upstreamRequest = input;
    return Response.json({ output: [] }, { status: 200 });
  });

  expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: [] });
});

test("forwards standalone Web Search through the authenticated native Codex route", async () => {
  const body = JSON.stringify({ query: "Codex Web Search passthrough" });
  const request = new Request("http://127.0.0.1:17841/v1/alpha/search?locale=en", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      host: "127.0.0.1:17841",
    },
    body,
  });
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "alpha/search", async input => {
    upstreamRequest = input;
    return Response.json({ results: [{ title: "result" }] });
  });

  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search?locale=en");
  expect(upstreamRequest!.method).toBe("POST");
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstreamRequest!.headers.get("host")).toBeNull();
  expect(await upstreamRequest!.text()).toBe(body);
  expect(await response.json()).toEqual({ results: [{ title: "result" }] });
});

test("removes ChatGPT Web item identities before native Codex compaction", async () => {
  const body = {
    model: "gpt-5.6-sol",
    store: false,
    previous_response_id: "resp_local_web_turn",
    input: [
      {
        type: "reasoning",
        id: "rs_2e94d82c29b14b14bb34eae3252fa756",
        summary: [{ type: "summary_text", text: "Pro thinking" }],
        content: null,
        encrypted_content: null,
      },
      {
        type: "reasoning",
        id: "rs_11111111111111111111111111111111",
        summary: [{ type: "summary_text", text: "Bridge envelope reasoning" }],
        encrypted_content: "ocxr1:eyJ0eHQiOiJoaWRkZW4ifQ==",
      },
      {
        type: "reasoning",
        id: "rs_55555555555555555555555555555555",
        summary: [],
        encrypted_content: "gAAAAABnative-opaque-reasoning",
      },
      {
        type: "message",
        id: "msg_22222222222222222222222222222222",
        role: "assistant",
        content: [{ type: "output_text", text: "Visible answer", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_33333333333333333333333333333333",
        call_id: "call_keep_linkage",
        name: "exec_command",
        arguments: "{}",
      },
      { type: "compaction_trigger" },
    ],
  };
  const originalBody = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  }, body);

  expect(upstreamRequest!.headers.get("content-encoding")).toBeNull();
  const forwarded = await upstreamRequest!.json() as {
    previous_response_id?: string;
    input: Array<Record<string, unknown>>;
  };
  expect(forwarded).not.toHaveProperty("previous_response_id");
  expect(forwarded.input.every(item => !("id" in item))).toBe(true);
  expect(forwarded.input.some(item => "encrypted_content" in item
    && typeof item.encrypted_content === "string"
    && item.encrypted_content.startsWith("ocxr1:"))).toBe(false);
  expect(forwarded.input).toContainEqual({
    type: "reasoning",
    summary: [],
    encrypted_content: "gAAAAABnative-opaque-reasoning",
  });
  expect(forwarded.input[0]).toMatchObject({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Pro thinking" }],
  });
  expect(forwarded.input[3]).toMatchObject({
    type: "message",
    role: "assistant",
  });
  expect(forwarded.input[4]).toMatchObject({
    type: "function_call",
    call_id: "call_keep_linkage",
  });
  expect(forwarded.input.at(-1)).toEqual({ type: "compaction_trigger" });
});

test("keeps native encrypted reasoning requests byte-for-byte intact", async () => {
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [{
      type: "reasoning",
      id: "rs_44444444444444444444444444444444",
      summary: [],
      encrypted_content: "gAAAAABnative-opaque-reasoning",
    }],
  });
  const originalBody = Bun.zstdCompressSync(Buffer.from(body));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  });

  expect(upstreamRequest!.headers.get("content-encoding")).toBe("zstd");
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
});

test("converts a bridge compact summary before switching to native Codex", async () => {
  const body = {
    model: "gpt-5.6-sol",
    previous_response_id: "resp_local_web_compact",
    input: [
      { type: "compaction", id: "cmp_local", encrypted_content: encodeCompactionSummary("Retained Web handoff") },
      { type: "compaction", id: "cmp_native", encrypted_content: "gAAAAABnative-opaque-compaction" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue natively" }] },
    ],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  });

  const forwarded = await upstreamRequest!.json() as {
    previous_response_id?: string;
    input: Array<Record<string, unknown>>;
  };
  expect(forwarded).not.toHaveProperty("previous_response_id");
  expect(forwarded.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nRetained Web handoff` }],
  });
  expect(forwarded.input[1]).toEqual({
    type: "compaction",
    encrypted_content: "gAAAAABnative-opaque-compaction",
  });
});

test("native passthrough fails closed without Codex bearer authentication", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  await expect(forwardNativeCodexRequest(request, "responses")).rejects.toThrow(
    "Native Codex passthrough requires the incoming Bearer authorization",
  );
});

test("forwards native model discovery as GET and preserves the client version query", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=0.99.0", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "old-etag" },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.99.0");
  expect(upstreamRequest!.method).toBe("GET");
  expect(upstreamRequest!.headers.get("if-none-match")).toBeNull();
});

test("preserves upstream Bad Request responses while reporting content-free request metadata", async () => {
  const privatePrompt = "private prompt that must never enter diagnostics";
  const imageUrl = `data:image/png;base64,${"A".repeat(4_096)}`;
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: privatePrompt }] },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] },
    ],
  });
  const request = new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
    },
    body,
  });
  const diagnostics: unknown[] = [];

  const response = await forwardNativeCodexRequest(
    request,
    "responses/compact",
    async () => new Response('{"detail":"Bad Request"}', {
      status: 400,
      headers: { "content-type": "application/json", "x-request-id": "req_safe-123" },
    }),
    undefined,
    diagnostic => diagnostics.push(diagnostic),
  );

  expect(response.status).toBe(400);
  expect(response.headers.get("x-request-id")).toBe("req_safe-123");
  expect(await response.text()).toBe('{"detail":"Bad Request"}');
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    endpoint: "responses/compact",
    requestBytes: Buffer.byteLength(body),
    contentEncoding: "identity",
    bodyRewritten: false,
    inputItems: 2,
    imageItems: 1,
    imageUrlChars: imageUrl.length,
    upstreamStatus: 400,
    requestId: "req_safe-123",
    outcome: "completed",
    errorName: null,
    errorCode: null,
  });
  expect((diagnostics[0] as { headersMs: number }).headersMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(diagnostics)).not.toContain(privatePrompt);
  expect(JSON.stringify(diagnostics)).not.toContain("AAAA");
  expect(JSON.stringify(diagnostics)).not.toContain("codex-oauth-token");
});

test("reports transport failures without leaking the upstream error message", async () => {
  const body = JSON.stringify({ model: "gpt-5.6-sol", input: [] });
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "identity",
    },
    body,
  });
  const diagnostics: unknown[] = [];

  await expect(forwardNativeCodexRequest(
    request,
    "responses",
    async () => {
      throw Object.assign(new TypeError("private socket failure detail"), { code: "ECONNRESET" });
    },
    undefined,
    diagnostic => diagnostics.push(diagnostic),
  )).rejects.toThrow("private socket failure detail");

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    endpoint: "responses",
    requestBytes: Buffer.byteLength(body),
    contentEncoding: "identity",
    bodyRewritten: false,
    inputItems: 0,
    imageItems: 0,
    imageUrlChars: 0,
    upstreamStatus: null,
    requestId: null,
    outcome: "failed",
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  });
  expect(JSON.stringify(diagnostics)).not.toContain("private socket failure detail");
  expect(JSON.stringify(diagnostics)).not.toContain("codex-oauth-token");
});

test("classifies a native headers abort separately from a transport failure", async () => {
  const client = new AbortController();
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    signal: client.signal,
  });
  const diagnostics: unknown[] = [];
  const aborted = new DOMException("private abort reason", "AbortError");

  const forwarded = forwardNativeCodexRequest(
    request,
    "responses",
    input => new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    }),
    undefined,
    diagnostic => diagnostics.push(diagnostic),
  );
  client.abort(aborted);

  await expect(forwarded).rejects.toBe(aborted);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    endpoint: "responses",
    outcome: "aborted",
    errorPhase: "headers",
    upstreamStatus: null,
    errorName: "AbortError",
    errorCode: "unknown",
  });
  expect(JSON.stringify(diagnostics)).not.toContain("private abort reason");
});

test("reports a pre-aborted native request without contacting upstream", async () => {
  const client = new AbortController();
  const aborted = new DOMException("private preflight reason", "AbortError");
  client.abort(aborted);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: "{}",
    signal: client.signal,
  });
  const diagnostics: unknown[] = [];
  let upstreamCalled = false;

  await expect(forwardNativeCodexRequest(
    request,
    "responses",
    async () => {
      upstreamCalled = true;
      return new Response();
    },
    undefined,
    diagnostic => diagnostics.push(diagnostic),
  )).rejects.toBe(aborted);

  expect(upstreamCalled).toBe(false);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ outcome: "aborted", errorPhase: "prepare" });
  expect(JSON.stringify(diagnostics)).not.toContain("private preflight reason");
});

test("marks bounded image metadata traversal as truncated", async () => {
  const oversizedContent = Array.from({ length: 100_001 }, () => ({ type: "input_text", text: "x" }));
  const decodedBody = {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: oversizedContent }],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: "{}",
  });
  const diagnostics: unknown[] = [];

  await forwardNativeCodexRequest(
    request,
    "responses",
    async () => new Response("data: done\n\n"),
    decodedBody,
    diagnostic => diagnostics.push(diagnostic),
  );

  expect(diagnostics[0]).toMatchObject({
    inputItems: 1,
    summaryTruncated: true,
    visitedNodes: 100_000,
    outcome: "completed",
  });
});

test("repairs a missing models client_version from an exact first-party Codex user agent", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      "user-agent": "codex_chatgpt_desktop/0.151.0-alpha.7.2 (Mac OS 15.6; arm64) Codex",
    },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.151.0");
});

test("does not invent a models client version from an unrelated user agent", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      "user-agent": "Mozilla/5.0 Codex/999.999.999",
    },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models");
});
