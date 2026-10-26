import { randomBytes } from "node:crypto";
import type { BrokerToolResult } from "./turn-broker-protocol";

export function gatewayResultMarker(): string {
  return `codex-tool-result:${randomBytes(18).toString("hex")}:`;
}

// Generated exec prints one invocation-bound record; ordinary output is never metadata.
export function decodeGatewayResult(response: BrokerToolResult, marker: string): BrokerToolResult {
  if (response.isError) return response;
  const records: string[] = [];
  const content = response.content.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
    const block = item as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") return [item];
    const text = block.text.split(/(?<=\n)/).filter(line => {
      if (!line.startsWith(marker)) return true;
      records.push(line.slice(marker.length).trimEnd());
      return false;
    }).join("");
    return text ? [{ ...block, text }] : [];
  });
  if (records.length !== 1) throw new Error("Native gateway did not return one matching result record");
  let parsed: unknown;
  try { parsed = JSON.parse(records[0]!); }
  catch { throw new Error("Native gateway returned invalid result metadata"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native gateway returned invalid result metadata");
  }
  const metadata = parsed as Record<string, unknown>;
  if (Object.keys(metadata).some(key => key !== "structuredContent" && key !== "isError")
    || (Object.hasOwn(metadata, "isError") && typeof metadata.isError !== "boolean")
    || (Object.hasOwn(metadata, "structuredContent") && (!metadata.structuredContent
      || typeof metadata.structuredContent !== "object" || Array.isArray(metadata.structuredContent)))) {
    throw new Error("Native gateway returned invalid result metadata");
  }
  return {
    ...response, content,
    ...(Object.hasOwn(metadata, "structuredContent") ? { structuredContent: metadata.structuredContent } : {}),
    ...(typeof metadata.isError === "boolean" ? { isError: metadata.isError } : {}),
  };
}
