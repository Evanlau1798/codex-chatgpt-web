import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker-client";

test.each([5000, null])("validated broker frame settles before peer EOF (timeout=%s)", async timeout => {
  const root = mkdtempSync(join(tmpdir(), "cgw-frame-"));
  const endpoint = defaultBrokerEndpoint(root);
  if (process.platform !== "win32") mkdirSync(join(root, "runtime"));
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const request = JSON.parse(buffered.split("\n")[0]!);
      socket.write(JSON.stringify({ id: request.id, result: { acknowledged: true } }) + "\n");
      // Intentionally no socket.end(): this is the actual failing boundary.
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  try {
    expect(await callTurnBroker<{ acknowledged: boolean }>(endpoint, { method: "owner_status" }, timeout)).toEqual({ acknowledged: true });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
