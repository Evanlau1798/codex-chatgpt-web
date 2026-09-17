import { expect, test } from "bun:test";
import {
  consumeConnectorContractProbeEvidence,
  discardConnectorContractProbeEvidence,
  NATIVE2_CONTRACT_REVISION,
  ZERO_RISK_CONTRACT_REVISION,
  connectorContractProbeQuery,
  recordConnectorContractProbeQuery,
  verifyCurrentConnectorContract,
} from "../src/adapters/chatgpt-web/connector-contract";

test("current connector verification uses reserved inventory semantics without a public tool", async () => {
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async () => {}))
    .rejects.toThrow("did not execute the current runtime contract probe");

  let observedRevision = "";
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    observedRevision = probe.contractRevision;
    expect(probe.prompt).toContain("codex_tool_inventory");
    expect(probe.prompt).toContain(probe.query);
    expect(probe.prompt).toContain("current turn_token");
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
