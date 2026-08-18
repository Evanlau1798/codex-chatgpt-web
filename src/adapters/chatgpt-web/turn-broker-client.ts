import { createConnection } from "node:net";
import {
  errorOf,
  MAX_BROKER_LINE_CHARS,
  opaqueId,
  type BrokerRequest,
  type BrokerResponse,
} from "./turn-broker-protocol";

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
): Promise<T> {
  const id = opaqueId("request");
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectCall(error);
    };
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => finishError(new Error("ChatGPT web turn broker timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`)));
    const finishClosed = () => finishError(new Error("ChatGPT web turn broker closed the connection"));
    socket.once("end", finishClosed);
    socket.once("close", finishClosed);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
    socket.on("data", chunk => {
      if (settled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let response: BrokerResponse;
      try {
        response = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (response.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    });
  });
}
