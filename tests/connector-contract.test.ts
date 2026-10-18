import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { scopeHash } from "../src/adapters/chatgpt-web/mcp-request-diagnostics";
import {
  consumeConnectorContractProbeEvidence,
  discardConnectorContractProbeEvidence,
  NATIVE2_CONTRACT_REVISION,
  ZERO_RISK_CONTRACT_REVISION,
  connectorContractProbeQuery,
  recordConnectorContractProbeQuery,
  verifyCurrentConnectorContract,
} from "../src/adapters/chatgpt-web/connector-contract";

test("contract evidence correlates producer and consumer without revealing nonce or temp root", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  let nonce = "", query = "";
  try {
    await verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
      nonce = probe.nonce; query = probe.query;
      expect(recordConnectorContractProbeQuery(query, "native")).toBeTrue();
    });
    const events = log.mock.calls.flat().filter(line => String(line).startsWith("[chatgpt-web] connector_probe="))
      .map(line => JSON.parse(String(line).split("connector_probe=")[1]!));
    expect(events.map(event => event.phase)).toEqual(["expected", "produced", "consumed"]);
    for (const event of events) {
      expect(event.nonce_hash).toBe(scopeHash(nonce));
      expect(event.root_hash).toMatch(/^[a-f0-9]{12}$/);
      expect(event.root_hash).toBe(events[0].root_hash);
      expect(event.pid).toBe(process.pid);
      expect(Number.isFinite(Date.parse(event.at))).toBeTrue();
    }
    expect(events.at(-1)).toMatchObject({ matched: true });
    for (const secret of [nonce, query, tmpdir()]) expect(JSON.stringify(events)).not.toContain(secret);
    log.mockImplementation(() => { throw new Error("diagnostic sink unavailable"); });
    await verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
      recordConnectorContractProbeQuery(probe.query, "native");
    });
  } finally { log.mockRestore(); }
});

test("current connector verification uses reserved inventory semantics without a public tool", async () => {
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async () => {}))
    .rejects.toThrow("did not execute the current runtime contract probe");

  let observedRevision = "";
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    observedRevision = probe.contractRevision;
    expect(probe.prompt).toContain("codex_tool_inventory");
    expect(probe.prompt).toContain(probe.query);
    expect(probe.prompt).toContain("current turn_token");
    expect(probe.prompt).toContain("Do not send progress updates");
    expect(probe.prompt).toContain("Do not call any other work tool");
    expect(probe.prompt).not.toContain("Do not call any other tool.");
    expect(probe.prompt).not.toContain(`turn_${probe.nonce}`);
    expect(probe.prompt).not.toContain("codex_contract_probe exactly once");
    expect(recordConnectorContractProbeQuery(probe.query, "native")).toBeTrue();
  })).resolves.toBeUndefined();
  expect(observedRevision).toBe(NATIVE2_CONTRACT_REVISION);
});

test("reserved inventory probe records only the current contract revision and a valid nonce", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  discardConnectorContractProbeEvidence(nonce);
  expect(recordConnectorContractProbeQuery(
    connectorContractProbeQuery(NATIVE2_CONTRACT_REVISION, nonce),
    "native",
  )).toBeTrue();
  expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeTrue();
  expect(recordConnectorContractProbeQuery(
    connectorContractProbeQuery("stale-native2-revision", nonce),
    "native",
  )).toBeFalse();
  expect(recordConnectorContractProbeQuery(
    `__codex_contract_probe__:${NATIVE2_CONTRACT_REVISION}:not-a-valid-nonce`,
    "native",
  )).toBeFalse();
});

test("Zero Risk uses its own reserved inventory contract revision", async () => {
  let observedRevision = "";
  const requestId = "request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await expect(verifyCurrentConnectorContract("Codex Zero Risk", "safe", async probe => {
    observedRevision = probe.contractRevision;
    expect(probe.prompt).toContain("codex_turn_start");
    expect(probe.prompt).toContain(requestId);
    expect(probe.prompt).not.toContain(`request_${probe.nonce}`);
    expect(recordConnectorContractProbeQuery(probe.query, "safe")).toBeTrue();
  }, requestId)).resolves.toBeUndefined();
  expect(observedRevision).toBe(ZERO_RISK_CONTRACT_REVISION);
});
