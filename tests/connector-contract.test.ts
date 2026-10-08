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
  let missingEvidenceAttempts = 0;
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    missingEvidenceAttempts = probe.attempt;
  })).rejects.toThrow("did not execute the current runtime contract probe after attempt 1/1");
  expect(missingEvidenceAttempts).toBe(1);

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

test("Native2 retries only when ChatGPT completed without dispatching the inventory call", async () => {
  const attempts: number[] = [];
  const queries: string[] = [];
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    attempts.push(probe.attempt);
    queries.push(probe.query);
    if (probe.attempt === 2) expect(recordConnectorContractProbeQuery(probe.query, "native")).toBeTrue();
  }, undefined, { retryMissingEvidence: true })).resolves.toBeUndefined();
  expect(attempts).toEqual([1, 2]);
  expect(new Set(queries).size).toBe(2);
});

test("a retry never accepts the previous probe's evidence", async () => {
  let previousQuery = "";
  let previousNonce = "";
  const attempts: number[] = [];
  try {
    await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
      attempts.push(probe.attempt);
      if (probe.attempt === 1) {
        previousQuery = probe.query;
        previousNonce = probe.nonce;
      } else {
        recordConnectorContractProbeQuery(previousQuery, "native");
      }
    }, undefined, { retryMissingEvidence: true })).rejects.toThrow("after attempt 2/2");
    expect(attempts).toEqual([1, 2]);
  } finally {
    discardConnectorContractProbeEvidence(previousNonce);
  }
});

test("retry uses the fresh reference supplied for each attempt", async () => {
  const references = ["turn_first_probe", "turn_second_probe"];
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    expect(probe.prompt).toContain(references[probe.attempt - 1]!);
    expect(probe.prompt).not.toContain(references[2 - probe.attempt]!);
    if (probe.attempt === 2) recordConnectorContractProbeQuery(probe.query, "native");
  }, async attempt => references[attempt - 1]!, { retryMissingEvidence: true })).resolves.toBeUndefined();
});

test("a browser failure is propagated without retrying or retaining probe evidence", async () => {
  const failure = new Error("fixture browser failed");
  let calls = 0;
  let nonce = "";
  await expect(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
    calls += 1;
    nonce = probe.nonce;
    recordConnectorContractProbeQuery(probe.query, "native");
    throw failure;
  }, undefined, { retryMissingEvidence: true })).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(consumeConnectorContractProbeEvidence(nonce, NATIVE2_CONTRACT_REVISION)).toBeFalse();
});

test("Zero Risk remains single-shot even when a caller opts into missing-evidence retry", async () => {
  let calls = 0;
  await expect(verifyCurrentConnectorContract("Codex Zero Risk", "safe", async () => {
    calls += 1;
  }, "request_safe_probe", { retryMissingEvidence: true })).rejects.toThrow("after attempt 1/1");
  expect(calls).toBe(1);
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
