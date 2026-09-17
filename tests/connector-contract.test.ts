import { expect, test } from "bun:test";
import {
  NATIVE2_CONTRACT_REVISION,
  ZERO_RISK_CONTRACT_REVISION,
  recordConnectorContractProbeEvidence,
  verifyCurrentConnectorContract,
} from "../src/adapters/chatgpt-web/connector-contract";

test("current connector verification requires actual probe execution", async () => {
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async () => {}))
    .rejects.toThrow("Recreate Codex Native2");

  let observedRevision = "";
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    observedRevision = probe.contractRevision;
    expect(probe.prompt).toContain("codex_contract_probe");
    expect(probe.prompt).toContain(probe.nonce);
    recordConnectorContractProbeEvidence(probe.nonce, probe.contractRevision);
  })).resolves.toBeUndefined();
  expect(observedRevision).toBe(NATIVE2_CONTRACT_REVISION);
});

test("Zero Risk uses its own current-schema revision and same-name recreate guidance", async () => {
  let observedRevision = "";
  await expect(verifyCurrentConnectorContract("Codex Zero Risk", "safe", async probe => {
    observedRevision = probe.contractRevision;
  })).rejects.toThrow("Recreate Codex Zero Risk");
  expect(observedRevision).toBe(ZERO_RISK_CONTRACT_REVISION);
});
