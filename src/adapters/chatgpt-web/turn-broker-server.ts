import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isWindowsPipeEndpoint } from "../../config";
import {
  errorOf,
  MAX_BROKER_LINE_CHARS,
  type BrokerRequest,
  type BrokerResponse,
} from "./turn-broker-protocol";

type BrokerDispatch = (request: BrokerRequest, signal: AbortSignal) => unknown | Promise<unknown>;

const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function writeSocketResponse(socket: Socket, response: BrokerResponse): void {
  const line = `${JSON.stringify(response)}\n`;
  if (line.length > MAX_BROKER_LINE_CHARS) {
    socket.end(`${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`);
    return;
  }
  socket.end(line);
}

function validateRequest(request: BrokerRequest): void {
  if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
    throw new Error("turn broker request id is invalid");
  }
  if (request.method !== "claim" && request.method !== "resolve" && request.method !== "release"
    && request.method !== "invoke" && request.method !== "read_context"
    && request.method !== "submit_compaction_handoff"
    && request.method !== "owner_status" && request.method !== "owner_register"
    && request.method !== "owner_update" && request.method !== "owner_next"
    && request.method !== "owner_complete" && request.method !== "owner_completion_fence_begin"
    && request.method !== "owner_completion_fence_commit" && request.method !== "owner_revoke"
    && request.method !== "activity_complete") {
    throw new Error("turn broker method is invalid");
  }
}

function handleSocket(socket: Socket, dispatch: BrokerDispatch): void {
  let buffered = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", chunk => {
    if (handled) return;
    buffered += chunk;
    if (buffered.length > MAX_BROKER_LINE_CHARS && !buffered.slice(0, MAX_BROKER_LINE_CHARS + 1).includes("\n")) {
      handled = true;
      writeSocketResponse(socket, { id: "unknown", error: "turn broker request exceeds size limit" });
      return;
    }
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    const line = buffered.slice(0, newline);
    let request: BrokerRequest | undefined;
    try {
      if (line.length > MAX_BROKER_LINE_CHARS) throw new Error("turn broker request exceeds size limit");
      request = JSON.parse(line) as BrokerRequest;
      validateRequest(request);
    } catch (error) {
      writeSocketResponse(socket, { id: request?.id ?? "unknown", error: errorOf(error).message });
      return;
    }
    const requestAbort = new AbortController();
    socket.once("close", () => requestAbort.abort());
    void Promise.resolve().then(() => dispatch(request!, requestAbort.signal)).then(
      result => writeSocketResponse(socket, { id: request!.id, result }),
      error => writeSocketResponse(socket, { id: request!.id, error: errorOf(error).message }),
    );
  });
}

export function startTurnBrokerServer(socketPath: string, dispatch: BrokerDispatch): Promise<Server> {
  return new Promise<Server>((resolveStart, rejectStart) => {
    const windowsPipe = isWindowsPipeEndpoint(socketPath);
    if (!windowsPipe) {
      const encodedLength = Buffer.byteLength(socketPath);
      if (encodedLength > MAX_UNIX_SOCKET_PATH_BYTES) {
        rejectStart(new Error(
          `ChatGPT web broker socket path is ${encodedLength} bytes, over the`
          + ` ${MAX_UNIX_SOCKET_PATH_BYTES}-byte limit for portable Unix sockets: ${socketPath}`,
        ));
        return;
      }
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    }
    const listen = () => {
      const server = createServer(socket => handleSocket(socket, dispatch));
      server.once("error", rejectStart);
      server.on("error", error => {
        console.error(`[chatgpt-web] turn broker server error at ${socketPath}: ${errorOf(error).message}`);
      });
      server.listen(socketPath, () => {
        server.off("error", rejectStart);
        if (!windowsPipe) chmodSync(socketPath, 0o600);
        resolveStart(server);
      });
    };
    if (windowsPipe) {
      listen();
      return;
    }
    if (!existsSync(socketPath)) {
      listen();
      return;
    }
    if (!lstatSync(socketPath).isSocket()) {
      rejectStart(new Error(`ChatGPT web broker path exists and is not a socket: ${socketPath}`));
      return;
    }
    const socketStat = lstatSync(socketPath);
    const getuid = process.getuid;
    if (typeof getuid === "function" && socketStat.uid !== getuid()) {
      rejectStart(new Error(`ChatGPT web broker socket is not owned by the current user: ${socketPath}`));
      return;
    }
    if ((socketStat.mode & 0o077) !== 0) {
      rejectStart(new Error(`ChatGPT web broker socket has unsafe permissions: ${socketPath}`));
      return;
    }
    const probe = createConnection(socketPath);
    let probeSettled = false;
    const finishProbe = (action: () => void) => {
      if (probeSettled) return;
      probeSettled = true;
      probe.destroy();
      action();
    };
    probe.setTimeout(2_000, () => finishProbe(() => {
      rejectStart(new Error(`Timed out while checking existing ChatGPT web broker socket: ${socketPath}`));
    }));
    probe.once("connect", () => finishProbe(() => {
      rejectStart(new Error(`ChatGPT web broker socket is already owned by another process: ${socketPath}`));
    }));
    probe.once("error", error => finishProbe(() => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED" && code !== "ENOENT") {
        rejectStart(new Error(`Could not verify existing ChatGPT web broker socket ${socketPath}: ${error.message}`));
        return;
      }
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
        listen();
      } catch (cleanupError) {
        rejectStart(errorOf(cleanupError));
      }
    }));
  });
}
