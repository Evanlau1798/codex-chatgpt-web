import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

/** Real Pi CLI, production HTTP/adapter/broker; only the external Web page is a scripted worker. */
export async function runPiNativeBrokerProbe(options: {
  temporary: string;
  agentDir: string;
  safety: ChatGptAccountSafety;
  runPrint: (extra: string[]) => Promise<{ out: string; code: number; err: string }>;
}): Promise<Record<string, unknown>> {
  const { temporary, agentDir, safety, runPrint } = options;
  const config = { ...defaultConfig("full"), port: 0, useEnhancedWebSessionMode: true,
    useEnhancedOutputTunnel: false, brokerSocketPath: defaultBrokerEndpoint(join(temporary, "native-broker")) };
  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  let browserStarts = 0;
  const worker = { async run(turn: BrowserTurn): Promise<string> {
    browserStarts++;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("Native2 broker token was absent from the production prompt");
      const { bindingId } = await callTurnBroker<{ bindingId: string }>(config.brokerSocketPath,
        { method: "claim", token });
      const invoked = callTurnBroker(config.brokerSocketPath, { method: "invoke", bindingId,
        wireName: "read", freeform: false, arguments: { path: "input.txt" } }, 90_000);
      const progress = turn.externalProgress!;
      while (!progress.snapshot().lastToolBatchRevision) {
        await progress.waitForChange(progress.snapshot().revision, turn.abortSignal);
      }
      await progress.acknowledgeToolBatch(progress.snapshot().lastToolBatchRevision);
      const result = await invoked;
      if (!JSON.stringify(result).includes("INERT_PI_FIXTURE")) throw new Error("Pi native result was not delivered to its original Web turn");
      turn.onTextDelta("PI_NATIVE_LOOP_OK");
      return "PI_NATIVE_LOOP_OK";
    } finally { prepared.release(); }
  } };
  const server = startServer(config, { adapterFactory: provider => createChatGptWebAdapter(provider,
    { broker, worker, accountSafety: safety }) });
  try {
    const modelsPath = join(agentDir, "models.json");
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    models.providers.enhanced.baseUrl = `http://127.0.0.1:${server.port}/v1`;
    writeFileSync(modelsPath, JSON.stringify(models));
    const pi = await runPrint(["--tools", "read", "Read input.txt and report PI_NATIVE_LOOP_OK after the read result."]);
    if (pi.code !== 0 || !pi.out.includes("PI_NATIVE_LOOP_OK") || browserStarts !== 1
      || pi.out.includes('"stopReason":"error"')) {
      throw new Error(`Pi native tool continuation failed: exit=${pi.code}, browserStarts=${browserStarts}, stderr=${pi.err.slice(0, 250)}`);
    }
    return { case: "native-broker-single-web-generation", status: "PASS", browserStarts };
  } finally { await server.stop(true); await broker.close(); }
}
