import { createConnection } from "node:net";
import {
  errorOf,
  MAX_BROKER_LINE_CHARS,
  opaqueId,
  type BrokerRequest,
  type BrokerResponse,
} from "./turn-broker-protocol";

export class TurnBrokerTimeoutError extends Error {
  constructor() {
    super("ChatGPT web turn broker timed out");
    this.name = "TurnBrokerTimeoutError";
  }
}

/**
 * A turn registered without a TTL has no deadline to bound its tool calls against, so a null
 * timeout waits for as long as the turn itself lives. Undefined keeps the bounded default, because
 * a caller that cannot compute a deadline must not silently inherit an unbounded wait. An
 * unbounded call still ends when the turn is revoked or the broker drops the connection.
 */
export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs: number | null = 5_000,
  signal?: AbortSignal,
): Promise<T> {
  const id = opaqueId("request");
  const wireRequest = request.method === "claim" && request.activityId === undefined
    ? { ...request, activityId: opaqueId("activity") }
    : request.method === "invoke" && timeoutMs !== null
      ? { ...request, invokeDeadlineAt: Date.now() + timeoutMs }
      : request;
  return new Promise<T>((resolveCall, rejectCall) => {
    if (signal?.aborted) {
      rejectCall(new DOMException("turn broker call aborted", "AbortError"));
      return;
    }
    const socket = createConnection(socketPath);
    let buffered = "";
    let settled = false;
    let responseAccepted = false;
    let response: BrokerResponse | undefined;
    const onAbort = () => {
      if (!responseAccepted) finishError(new DOMException("turn broker call aborted", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      setImmediate(() => socket.destroy());
      rejectCall(error);
    };
    const finishResponse = () => {
      if (settled) return;
      if (!response) {
        finishError(new Error("ChatGPT web turn broker closed the connection"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      // This RPC is finished, regardless of whether its peer sends EOF.
      // Do not leave a referenced socket alive after removing its abort/timer.
      // Graceful shutdown is deferred out of the data callback; successful
      // Windows/Bun pipes must not race a force-destroy against their end path.
      socket.unref();
      setImmediate(() => {
        if (!socket.destroyed && !socket.writableEnded && !socket.readableEnded) socket.end();
      });
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    };
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => {
        if (!responseAccepted) finishError(new TurnBrokerTimeoutError());
      }, timeoutMs);
    socket.setEncoding("utf8");
    if (signal?.aborted) {
      finishError(new DOMException("turn broker call aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", error => {
      if (!responseAccepted) finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`));
    });
    socket.once("end", () => {
      if (response) responseAccepted = true;
      socket.end();
      setImmediate(finishResponse);
    });
    socket.once("close", () => {
      if (response) responseAccepted = true;
      setImmediate(finishResponse);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...wireRequest })}\n`));
    socket.on("data", chunk => {
      if (settled || response) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let parsed: BrokerResponse;
      try {
        parsed = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || ("result" in parsed) === ("error" in parsed)
        || ("error" in parsed && (typeof parsed.error !== "string" || !parsed.error))) {
        finishError(new Error("ChatGPT web turn broker returned an invalid response frame"));
        return;
      }
      if (parsed.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      response = parsed;
      responseAccepted = true;
      finishResponse();
    });
  });
}
