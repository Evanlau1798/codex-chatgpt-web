import { createServer, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectChatGptMcpServer, createChatGptMcpServer, type ChatGptMcpContract } from "./mcp-server";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_REQUESTS = 32;

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization;
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function localOrigin(request: IncomingMessage, port: number): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.host ?? "") || request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  return origin === undefined || (typeof origin === "string" && hosts.some(host => origin === `http://${host}`));
}

async function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      chunks.length = 0;
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("mcp_request_aborted"));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        // Breaking IncomingMessage's async iterator destroys the socket and
        // loses the 413 response. Stop retaining data but drain the body.
        fail(new Error("mcp_body_too_large"));
        request.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        cleanup();
        resolve(value);
      } catch (error) { fail(error instanceof Error ? error : new Error("invalid_json")); }
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

/** Opt-in, authenticated stateless MCP. Each HTTP request owns its RPC namespace. */
export async function startChatGptMcpHttpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
  controlToken: string;
  port?: number;
}) {
  if (options.controlToken.length < 32) throw new Error("MCP HTTP requires the existing private control token");
  const portOption = options.port ?? 17842;
  if (!Number.isInteger(portOption) || portOption < 0 || portOption > 65535) throw new Error("Invalid MCP HTTP port");
  let active = 0, closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    const reject = (status: number, code: string) => {
      request.resume();
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: code }));
    };
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : -1;
    if (!authorized(request, options.controlToken)) { reject(401, "unauthorized"); return; }
    if (!localOrigin(request, port)) { reject(403, "forbidden_origin"); return; }
    if (request.url !== "/mcp") { reject(404, "not_found"); return; }
    if (request.method !== "POST") { reject(405, "post_required"); return; }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") { reject(415, "json_required"); return; }
    const length = Number(request.headers["content-length"]);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) { reject(413, "mcp_body_too_large"); return; }
    if (closing || active >= MAX_REQUESTS) { reject(503, "mcp_capacity_unavailable"); return; }
    const requestId = randomUUID();
    response.setHeader("x-cgw-mcp-request-id", requestId);
    active++;
    let mcp: ReturnType<typeof createChatGptMcpServer> | undefined;
    const disconnected = () => {
      if (!response.writableEnded) void mcp?.close().catch(() => {});
    };
    response.on("close", disconnected);
    try {
      const value = await body(request);
      if (request.aborted || response.destroyed) return;
      mcp = createChatGptMcpServer(options);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await connectChatGptMcpServer(mcp, transport, requestId);
      if (response.destroyed) return;
      await transport.handleRequest(request, response, value);
    } catch (error) {
      // Never include exception text, authorization, tool input or request body.
      if (!response.headersSent && !response.destroyed) reject(
        error instanceof Error && error.message === "mcp_body_too_large" ? 413 : 400, "invalid_mcp_request");
    } finally {
      response.off("close", disconnected);
      try { await mcp?.close(); } catch { /* Isolated transport cleanup only. */ }
      active--;
    }
  });
  server.listen(portOption, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP HTTP listener did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    activeRequests: () => active,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      // Graceful shutdown waits for real requests; no slow-work lifetime timer.
      closePromise = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        // Explicitly retire only idle keep-alive connections for runtimes
        // whose Node compatibility layer does not do so as part of close().
        // Never use closeAllConnections(): active native work must survive.
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
