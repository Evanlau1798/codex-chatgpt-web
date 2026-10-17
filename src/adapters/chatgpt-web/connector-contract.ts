import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatGptMcpContract } from "./mcp-zero-risk";

export const NATIVE2_CONTRACT_REVISION = "native2-enhanced-2026-09-17-1";
export const ZERO_RISK_CONTRACT_REVISION = "zero-risk-2026-09-17-1";
export const NATIVE2_PUBLIC_CONTRACT_HASH = "28b2ed2e0333df5e23918b820f164dd6001016672a17e9528a6268e862b6dd33";
export const ZERO_RISK_PUBLIC_CONTRACT_HASH = "0c21b46d44ec5ade78a4059d2ecdb6686fafadafc454d39ec5d595687cf05bd6";

const NONCE_PATTERN = /^[a-f0-9]{32}$/;
// The ChatGPT rich-text composer serializes literal underscores as Markdown
// escapes, which can survive in the tool argument. Accept that exact spelling
// variation only in the reserved prefix; revision and nonce stay strict.
const PROBE_QUERY_PATTERN = /^(?:\\?_){2}codex\\?_contract\\?_probe(?:\\?_){2}:([^:]+):([a-f0-9]{32})$/;
const PROBE_DIR = join(tmpdir(), "codex-chatgpt-web-contract-probes");
const PROBE_FALLBACK_DIR = join(PROBE_DIR, "fallback");
const PROBE_FALLBACK_TTL_MS = 120_000;

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Connector contract probe nonce is invalid");
}

function evidencePath(nonce: string): string {
  assertNonce(nonce);
  return join(PROBE_DIR, `${nonce}.json`);
}

function fallbackPath(turnToken: string): string {
  if (!turnToken.trim()) throw new Error("Connector contract probe turn token is empty");
  const digest = createHash("sha256").update(turnToken).digest("hex");
  return join(PROBE_FALLBACK_DIR, `${digest}.json`);
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

/**
 * ChatGPT occasionally dispatches Native2 inventory without the optional
 * reserved query even though the verification prompt requested it. Arm a
 * one-turn fallback bound to the broker token so that only that active
 * verification can produce the same local evidence. The raw token is never
 * written to disk.
 */
export function armConnectorContractProbeFallback(
  turnToken: string,
  nonce: string,
  contractRevision: string,
): void {
  assertNonce(nonce);
  mkdirSync(PROBE_FALLBACK_DIR, { recursive: true });
  writeFileSync(
    fallbackPath(turnToken),
    `${JSON.stringify({ nonce, contractRevision, expiresAt: Date.now() + PROBE_FALLBACK_TTL_MS })}\n`,
    { encoding: "utf8", flag: "w" },
  );
}

export function discardConnectorContractProbeFallback(turnToken: string): void {
  rmSync(fallbackPath(turnToken), { force: true });
}

export function recordConnectorContractProbeFallback(
  turnToken: string,
  contract: ChatGptMcpContract,
): boolean {
  const path = fallbackPath(turnToken);
  let removeMarker = false;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as {
      nonce?: unknown;
      contractRevision?: unknown;
      expiresAt?: unknown;
    };
    const expectedRevision = connectorContractRevision(contract);
    if (marker.contractRevision !== expectedRevision || typeof marker.nonce !== "string"
      || typeof marker.expiresAt !== "number") return false;
    if (marker.expiresAt < Date.now()) {
      removeMarker = true;
      return false;
    }
    recordConnectorContractProbeEvidence(marker.nonce, expectedRevision);
    removeMarker = true;
    return true;
  } catch {
    removeMarker = true;
    return false;
  } finally {
    if (removeMarker) rmSync(path, { force: true });
  }
}

export interface ConnectorContractProbe {
  contractRevision: string;
  nonce: string;
  query: string;
  prompt: string;
  attempt: number;
}

export interface ConnectorContractVerificationOptions {
  /**
   * Native2 can finish a browser turn without dispatching the requested MCP
   * call. Retry only that missing-evidence case; transport and UI failures
   * still fail immediately. Zero Risk stays single-shot because its startup
   * call owns the request lifecycle.
   */
  retryMissingEvidence?: boolean;
}

export async function verifyCurrentConnectorContract(
  appName: string,
  contract: ChatGptMcpContract,
  runProbe: (probe: ConnectorContractProbe) => Promise<void>,
  reference?: string | ((attempt: number) => Promise<string>),
  options?: ConnectorContractVerificationOptions,
): Promise<void> {
  const contractRevision = connectorContractRevision(contract);
  if (contract === "safe" && !reference) {
    throw new Error("Zero Risk connector contract verification requires a live request id");
  }
  const maxAttempts = contract === "native" && options?.retryMissingEvidence === true ? 2 : 1;
  let lastMissingEvidenceError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const currentReference = typeof reference === "function" ? await reference(attempt) : reference;
    const nonce = randomUUID().replaceAll("-", "");
    const query = connectorContractProbeQuery(contractRevision, nonce);
    const retryInstruction = attempt > 1
      ? "This is a retry because the previous turn did not dispatch the inventory call. The exact inventory call is mandatory; do not produce a final answer before it succeeds."
      : "";
    const prompt = contract === "safe"
      ? [
          "Protocol verification: make a real function call to the connected MCP tool codex_turn_start exactly once with",
          JSON.stringify({ request_id: currentReference }),
          "Then make a real function call to codex_tool_inventory exactly once with",
          JSON.stringify({ request_id: currentReference, query }),
          "Do not claim either call in prose and do not answer before the inventory tool result is returned. Do not call any other tool. After the inventory call succeeds, reply briefly.",
        ].join(" ")
      : currentReference
        ? [
            "Do not send progress updates for this connector verification.",
            "Protocol verification: you must make a real function call to the connected MCP tool codex_tool_inventory now. Do not write a prose claim that you called it.",
            retryInstruction,
            "Use exactly these arguments:",
            JSON.stringify({ turn_token: currentReference, query }),
            "Wait for the tool result before answering. Do not call any other work tool. After the inventory call succeeds, complete the brief final response through the bound output control if the transport requires it; otherwise reply briefly.",
          ].filter(Boolean).join(" ")
        : [
            "Do not send progress updates for this connector verification.",
            "Protocol verification: you must make a real function call to the connected MCP tool codex_tool_inventory now. Do not write a prose claim that you called it.",
            retryInstruction,
            "Use the current turn_token from codex_native_turn_binding and exactly these arguments:",
            JSON.stringify({ query }),
            "Wait for the tool result before answering. Do not call any other work tool. After the inventory call succeeds, complete the brief final response through the bound output control if the transport requires it; otherwise reply briefly.",
          ].filter(Boolean).join(" ");
    discardConnectorContractProbeEvidence(nonce);
    const fallbackArmed = contract === "native" && !!currentReference;
    if (fallbackArmed) armConnectorContractProbeFallback(currentReference!, nonce, contractRevision);
    try {
      await runProbe({ contractRevision, nonce, query, prompt, attempt });
      if (consumeConnectorContractProbeEvidence(nonce, contractRevision)) return;
      lastMissingEvidenceError = new Error(
        `${appName} did not execute the current runtime contract probe after attempt ${attempt}/${maxAttempts}.`,
      );
    } finally {
      discardConnectorContractProbeEvidence(nonce);
      if (fallbackArmed) discardConnectorContractProbeFallback(currentReference!);
    }
  }
  throw lastMissingEvidenceError ?? new Error(`${appName} did not execute the current runtime contract probe.`);
}
