import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accountSession from "../src/chatgpt-session";
import { defaultBrokerEndpoint } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { recordConnectorContractProbeQuery } from "../src/adapters/chatgpt-web/connector-contract";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test.each([true, false])("launcher retry renews and revokes both broker leases (success=%s)", async success => {
  const root = mkdtempSync(join(tmpdir(), "cgw-connector-retry-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  const account = spyOn(accountSession, "detectChatGptAccountCapabilities")
    .mockResolvedValue({ solAvailable: true, proAvailable: true, extraHighAvailable: true });
  const tokens: string[] = [];
  const traces: string[] = [];
  let cleared = false;
  const page = { evaluate: async () => ({
    location: { origin: "https://chatgpt.com", pathSegments: 0, temporaryChat: true },
    composer: { visibleCount: 1, textChars: [0], selectedConnectorCount: 0 },
  }) };
  const method = (ChatGptBrowserWorker.prototype as unknown as {
    verifyConnectorExclusive(traceId: string): Promise<string>;
  }).verifyConnectorExclusive;
  try {
    const result = method.call({
      config: { appName: "Codex Native2", brokerSocketPath: socket, browserDiagnosticsPath: root },
      ensurePage: async () => page,
      prepareChatSurface: async () => {},
      selectConnector: async () => {},
      runBrowserTurn: async (turn: any) => {
        const prompt = (await turn.prepare()).text;
        const args = JSON.parse(/\{"turn_token"[^}]+\}/.exec(prompt)![0]);
        tokens.push(args.turn_token);
        traces.push(turn.traceId);
        if (tokens.length === 2) {
          expect(tokens[1]).not.toBe(tokens[0]);
          await expect(callTurnBroker(socket, { method: "claim", token: tokens[0], contract: "native" }))
            .rejects.toThrow();
          if (success) recordConnectorContractProbeQuery(args.query, "native");
        }
        const claimed = await callTurnBroker<{ environment: { tools: unknown[]; writableRoots: string[] } }>(
          socket, { method: "claim", token: args.turn_token, contract: "native" },
        );
        expect(claimed.environment.tools).toEqual([]);
        expect(claimed.environment.writableRoots).toEqual([]);
      },
      clearChatGptComposerState: async () => { cleared = true; },
    }, `verify_retry_${success}`);
    if (success) expect(await result).toBe("Codex Native2");
    else await expect(result).rejects.toThrow("after attempt 2/2");
    expect(cleared).toBe(success);
    expect(traces).toEqual([`verify_retry_${success}_contract`, `verify_retry_${success}_contract_retry`]);
    for (const token of tokens) {
      await expect(callTurnBroker(socket, { method: "claim", token, contract: "native" })).rejects.toThrow();
    }
    const directory = readdirSync(root).find(name => name.startsWith(`verify_retry_${success}-`))!;
    const checkpoints = readdirSync(join(root, directory)).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(root, directory, name), "utf8")));
    expect(checkpoints.map(value => value.checkpoint)).toContain("connector-contract-retry");
    for (const token of tokens) expect(JSON.stringify(checkpoints)).not.toContain(token);
  } finally {
    account.mockRestore();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
