import {
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  type PreviousFeatureAssignment,
} from "./codex-integration-shared";

export interface InlineBooleanField {
  value: "true" | "false" | "unset";
  valueStart?: number;
  valueEnd?: number;
  bodyContentEnd: number;
}

function stripTomlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

function decodeKey(raw: string): string | undefined {
  const key = raw.trim();
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      const decoded = JSON.parse(key);
      return typeof decoded === "string" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  return key.startsWith("'") && key.endsWith("'") ? key.slice(1, -1) : undefined;
}

function topLevelEquals(raw: string, start: number, end: number): number | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = start; index < end; index += 1) {
    const char = raw[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth -= 1;
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth -= 1;
    else if (char === "=" && squareDepth === 0 && curlyDepth === 0) return index;
    if (squareDepth < 0 || curlyDepth < 0) return undefined;
  }
  return undefined;
}

export function parseInlineBooleanField(raw: string, key: string): InlineBooleanField | undefined {
  const value = stripTomlComment(raw);
  const openIndex = value.search(/\S/);
  if (openIndex < 0 || value[openIndex] !== "{") return undefined;
  let closeIndex = value.length;
  while (closeIndex > openIndex && /\s/.test(value[closeIndex - 1]!)) closeIndex -= 1;
  closeIndex -= 1;
  if (value[closeIndex] !== "}") throw new Error(`Could not parse ${key} inline table in Codex [features]`);

  const segments: Array<readonly [number, number]> = [];
  let segmentStart = openIndex + 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = segmentStart; index < closeIndex; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth -= 1;
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth -= 1;
    else if (char === "," && squareDepth === 0 && curlyDepth === 0) {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
    if (squareDepth < 0 || curlyDepth < 0) {
      throw new Error(`Could not parse ${key} inline table in Codex [features]`);
    }
  }
  if (quote || squareDepth !== 0 || curlyDepth !== 0) {
    throw new Error(`Could not parse ${key} inline table in Codex [features]`);
  }
  segments.push([segmentStart, closeIndex]);

  let match: { value: "true" | "false"; start: number; end: number } | undefined;
  for (const [start, end] of segments) {
    if (!value.slice(start, end).trim()) continue;
    const equals = topLevelEquals(value, start, end);
    if (equals === undefined) throw new Error(`Could not parse ${key} inline table in Codex [features]`);
    if (decodeKey(value.slice(start, equals)) !== "enabled") continue;
    let fieldStart = equals + 1;
    while (fieldStart < end && /\s/.test(value[fieldStart]!)) fieldStart += 1;
    let fieldEnd = end;
    while (fieldEnd > fieldStart && /\s/.test(value[fieldEnd - 1]!)) fieldEnd -= 1;
    const fieldValue = value.slice(fieldStart, fieldEnd);
    if (fieldValue !== "true" && fieldValue !== "false") {
      throw new Error("enabled in Codex [features].multi_agent_v2 inline table must be a boolean");
    }
    if (match) throw new Error("Codex [features].multi_agent_v2 inline table contains duplicate enabled assignments");
    match = { value: fieldValue, start: fieldStart, end: fieldEnd };
  }
  let bodyContentEnd = closeIndex;
  while (bodyContentEnd > openIndex + 1 && /\s/.test(value[bodyContentEnd - 1]!)) bodyContentEnd -= 1;
  return {
    value: match?.value ?? "unset",
    ...(match ? { valueStart: match.start, valueEnd: match.end } : {}),
    bodyContentEnd,
  };
}

export function managedMultiAgentV2AssignmentLine(previous: PreviousFeatureAssignment): string {
  if (!previous.inlineTable) {
    return previous.tableName === "features.multi_agent_v2"
      ? MANAGED_MULTI_AGENT_V2_TABLE_LINE
      : MANAGED_MULTI_AGENT_V2_LINE;
  }
  if (!previous.rawLine) throw new Error("Codex integration journal is missing the prior multi_agent_v2 inline table");
  const prefix = /^\s*multi_agent_v2\s*=\s*/.exec(previous.rawLine);
  if (!prefix) throw new Error("Could not parse the prior multi_agent_v2 inline table");
  const rawValue = previous.rawLine.slice(prefix[0].length);
  const inline = parseInlineBooleanField(rawValue, "multi_agent_v2");
  if (!inline) throw new Error("Could not parse the prior multi_agent_v2 inline table");
  if (inline.valueStart !== undefined && inline.valueEnd !== undefined) {
    return previous.rawLine.slice(0, prefix[0].length + inline.valueStart)
      + "false"
      + previous.rawLine.slice(prefix[0].length + inline.valueEnd);
  }
  const bodyHasValues = rawValue.slice(0, inline.bodyContentEnd).trimEnd().endsWith("{") === false;
  return previous.rawLine.slice(0, prefix[0].length + inline.bodyContentEnd)
    + `${bodyHasValues ? ", " : ""}enabled = false`
    + previous.rawLine.slice(prefix[0].length + inline.bodyContentEnd);
}
