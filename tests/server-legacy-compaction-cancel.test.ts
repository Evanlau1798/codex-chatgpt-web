import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { cancelAllStructuredCompactions, runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";

test("legacy browser cancellation settles fresh structured compaction owners", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  let aborted = false;
  const key = `legacy-cancel-${crypto.randomUUID()}`;
  const run = runStructuredCompactionOnce(key, { ownerKey: key, traceIds: [key] }, signal => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  void run.catch(() => {});
  try {
    await Bun.sleep(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-browser-turns`, {
      method: "POST", headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", cancelled_compaction_runs: 1 });
    expect(aborted).toBeTrue();
    await expect(run).rejects.toThrow("Active turn cancelled by launcher");
  } finally {
    await cancelAllStructuredCompactions(new Error("test cleanup"));
    await server.stop(true);
  }
});
