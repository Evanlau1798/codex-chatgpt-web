import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";

for (const runtime of ["node", "bun"] as const) for (const timeout of [5000, null]) {
  test(`completed RPC naturally retires child and socket without peer EOF (${runtime}, ${timeout})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-exit-"));
    const endpoint = defaultBrokerEndpoint(root);
    if (process.platform !== "win32") mkdirSync(join(root, "runtime"));
    const bundle = join(root, "client.cjs"), childScript = join(root, "caller.cjs");
    const source = process.env.BROKER_RETIREMENT_SOURCE ?? join(import.meta.dir, "../src/adapters/chatgpt-web/turn-broker-client.ts");
    const build = await Bun.build({ entrypoints: [source], target: "node", format: "cjs", outdir: root, naming: "client.cjs" });
    expect(build.success).toBe(true);
    writeFileSync(childScript, `const {callTurnBroker}=require(${JSON.stringify(bundle)});\n`
      + `callTurnBroker(${JSON.stringify(endpoint)},{method:'owner_status'},${JSON.stringify(timeout)})`
      + `.then(result=>console.log(JSON.stringify(result)),error=>{console.error(error);process.exitCode=1});\n`);
    const peers = new Set<Socket>();
    const peerClosed = Promise.withResolvers<void>();
    const server = createServer(socket => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => { peers.delete(socket); peerClosed.resolve(); });
      let text = "";
      socket.on("data", bytes => {
        text += bytes.toString();
        if (!text.includes("\n")) return;
        const request = JSON.parse(text.split("\n")[0]!);
        socket.write(JSON.stringify({ id: request.id, result: { acknowledged: true } }) + "\n");
        // Deliberately never end the peer: the client owns post-response retirement.
      });
    });
    server.listen(endpoint); await once(server, "listening");
    const child = Bun.spawn([runtime === "bun" ? process.execPath : "node", childScript], { stdout: "pipe", stderr: "pipe" });
    const replyObserved = Promise.withResolvers<void>();
    let output = "";
    const outputDrain = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          if (output.includes("\n")) replyObserved.resolve();
        }
        output += decoder.decode();
      } finally { reader.releaseLock(); }
    })();
    const stderrDrain = new Response(child.stderr).text();
    let guard: ReturnType<typeof setTimeout> | undefined;
    let retirementGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      // Separate cold Windows process startup from post-reply retirement.
      // The leak oracle still permits only 2s after the actual returned value.
      await Promise.race([replyObserved.promise, child.exited.then(async code => {
        await outputDrain;
        if (!output.includes("\n")) throw new Error(`Child exited before reply (${code}): ${await stderrDrain}`);
      }), new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("Child did not produce its RPC reply during startup")), 10_000);
      })]);
      clearTimeout(guard);
      const code = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("Returned RPC kept its child process alive")), 2000);
      })]);
      expect(code).toBe(0);
      await outputDrain;
      expect(output.trim()).toBe('{"acknowledged":true}');
      await Promise.race([peerClosed.promise, new Promise<never>((_, reject) => {
        retirementGuard = setTimeout(() => reject(new Error("Completed RPC left its peer socket alive")), 1000);
      })]);
      expect(peers.size).toBe(0);
    } finally {
      clearTimeout(guard); clearTimeout(retirementGuard);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
      await outputDrain;
      await stderrDrain;
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}
