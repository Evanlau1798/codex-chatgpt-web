import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptMcpContract } from "./mcp-zero-risk";

export const CHATGPT_CONNECTOR_CONTRACT_PROBE_TOOL = "codex_contract_probe";
export const NATIVE2_CONTRACT_REVISION = "native2-enhanced-2026-09-17-1";
export const ZERO_RISK_CONTRACT_REVISION = "zero-risk-2026-09-17-1";
export const NATIVE2_PUBLIC_CONTRACT_HASH = "dd7a1278dd77dfeafb2b3be5db9304e1342b49bc41ce419f4502c80be1a5f968";
export const ZERO_RISK_PUBLIC_CONTRACT_HASH = "c229b7d611dff0af244576b0071707b29084747ee43343a08d514d6e4e21b7b6";

const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const PROBE_DIR = join(tmpdir(), "codex-chatgpt-web-contract-probes");

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Connector contract probe nonce is invalid");
}

function evidencePath(nonce: string): string {
  assertNonce(nonce);
  return join(PROBE_DIR, `${nonce}.json`);
}

export function connectorContractRevision(contract: ChatGptMcpContract): string {
  return contract === "safe" ? ZERO_RISK_CONTRACT_REVISION : NATIVE2_CONTRACT_REVISION;
}

export function recordConnectorContractProbeEvidence(nonce: string, contractRevision: string): void {
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(evidencePath(nonce), `${JSON.stringify({ contractRevision })}\n`, { encoding: "utf8", flag: "wx" });
}

export function discardConnectorContractProbeEvidence(nonce: string): void {
  rmSync(evidencePath(nonce), { force: true });
}

export function consumeConnectorContractProbeEvidence(nonce: string, expectedRevision: string): boolean {
  const path = evidencePath(nonce);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { contractRevision?: unknown };
    return parsed.contractRevision === expectedRevision;
  } catch {
    return false;
  } finally {
    rmSync(path, { force: true });
  }
}

export interface ConnectorContractProbe {
  contractRevision: string;
  nonce: string;
  prompt: string;
}

export async function verifyCurrentConnectorContract(
  appName: string,
  contract: ChatGptMcpContract,
  runProbe: (probe: ConnectorContractProbe) => Promise<void>,
): Promise<void> {
  const contractRevision = connectorContractRevision(contract);
  const nonce = randomUUID().replaceAll("-", "");
  const prompt = [
    `Call ${CHATGPT_CONNECTOR_CONTRACT_PROBE_TOOL} exactly once with`,
    JSON.stringify({ contract_revision: contractRevision, nonce }),
    "Do not call any other tool. After the tool succeeds, reply briefly.",
  ].join(" ");
  discardConnectorContractProbeEvidence(nonce);
  try {
    await runProbe({ contractRevision, nonce, prompt });
    if (!consumeConnectorContractProbeEvidence(nonce, contractRevision)) {
      throw new Error(
        `${appName} exists, but ChatGPT is exposing a stale connector schema. Recreate ${appName} against the same tunnel.`,
      );
    }
  } finally {
    discardConnectorContractProbeEvidence(nonce);
  }
}
