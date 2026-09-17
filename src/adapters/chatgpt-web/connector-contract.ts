import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptMcpContract } from "./mcp-zero-risk";

export const NATIVE2_CONTRACT_REVISION = "native2-enhanced-2026-09-17-1";
export const ZERO_RISK_CONTRACT_REVISION = "zero-risk-2026-09-17-1";
export const NATIVE2_PUBLIC_CONTRACT_HASH = "28b2ed2e0333df5e23918b820f164dd6001016672a17e9528a6268e862b6dd33";
export const ZERO_RISK_PUBLIC_CONTRACT_HASH = "0c21b46d44ec5ade78a4059d2ecdb6686fafadafc454d39ec5d595687cf05bd6";

const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const PROBE_QUERY_PATTERN = /^__codex_contract_probe__:([^:]+):([a-f0-9]{32})$/;
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

export function connectorContractProbeQuery(contractRevision: string, nonce: string): string {
  assertNonce(nonce);
  return `__codex_contract_probe__:${contractRevision}:${nonce}`;
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

export function recordConnectorContractProbeQuery(query: string, contract: ChatGptMcpContract): boolean {
  const match = PROBE_QUERY_PATTERN.exec(query.trim());
  if (!match || match[1] !== connectorContractRevision(contract)) return false;
  recordConnectorContractProbeEvidence(match[2]!, match[1]);
  return true;
}

export function isConnectorContractProbeQuery(query: string, contract: ChatGptMcpContract): boolean {
  const match = PROBE_QUERY_PATTERN.exec(query.trim());
  return !!match && match[1] === connectorContractRevision(contract);
}

export interface ConnectorContractProbe {
  contractRevision: string;
  nonce: string;
  query: string;
  prompt: string;
}

export async function verifyCurrentConnectorContract(
  appName: string,
  contract: ChatGptMcpContract,
  runProbe: (probe: ConnectorContractProbe) => Promise<void>,
  reference?: string,
): Promise<void> {
  const contractRevision = connectorContractRevision(contract);
  const nonce = randomUUID().replaceAll("-", "");
  const query = connectorContractProbeQuery(contractRevision, nonce);
  if (contract === "safe" && !reference) {
    throw new Error("Zero Risk connector contract verification requires a live request id");
  }
  const prompt = contract === "safe"
    ? [
        "Call codex_turn_start exactly once with",
        JSON.stringify({ request_id: reference }),
        "Then call codex_tool_inventory exactly once with",
        JSON.stringify({ request_id: reference, query, include_schema: false }),
        "Do not call any other tool. After the inventory call succeeds, reply briefly.",
      ].join(" ")
    : reference
      ? [
          "Do not send progress updates for this connector verification.",
          "Call codex_tool_inventory exactly once with",
          JSON.stringify({ turn_token: reference, query, include_schema: false }),
          "Do not call any other work tool. After the inventory call succeeds, complete the brief final response through the bound output control if the transport requires it; otherwise reply briefly.",
        ].join(" ")
      : [
          "Do not send progress updates for this connector verification.",
          "Call codex_tool_inventory exactly once using the current turn_token from codex_native_turn_binding, with",
          JSON.stringify({ query, include_schema: false }),
          "Do not call any other work tool. After the inventory call succeeds, complete the brief final response through the bound output control if the transport requires it; otherwise reply briefly.",
        ].join(" ");
  discardConnectorContractProbeEvidence(nonce);
  try {
    await runProbe({ contractRevision, nonce, query, prompt });
    if (!consumeConnectorContractProbeEvidence(nonce, contractRevision)) {
      throw new Error(
        `${appName} did not execute the current runtime contract probe.`,
      );
    }
  } finally {
    discardConnectorContractProbeEvidence(nonce);
  }
}
