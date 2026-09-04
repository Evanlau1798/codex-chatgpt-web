import {
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  MANAGED_REMOTE_COMPACTION_LINE,
  MIN_COMPATIBILITY_V1_AGENT_DEPTH,
  managedAgentMaxDepthLine,
} from "./codex-integration-shared";
import type {
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  PreviousAssignment,
  PreviousAgentAssignment,
  PreviousFeatureAssignment,
} from "./codex-integration-shared";

import {
  assignmentRegex,
  insertDocumentLine,
  parseDocument,
  removeManagedComment,
  removeDocumentLine,
  renderDocument,
  splitLines,
  stripTomlComment,
} from "./codex-integration-toml";
import type { CodexConfigDocument } from "./codex-integration-toml";
import {
  managedMultiAgentV2AssignmentLine,
  parseInlineBooleanField,
} from "./codex-integration-inline";
export { managedMultiAgentV2AssignmentLine } from "./codex-integration-inline";
export {
  assignments,
  findTopLevelAssignment,
  firstTableIndex,
  insertDocumentLine,
  parseDocument,
  readCodexModelContextOverride,
  removeManagedComment,
  removeDocumentLine,
  renderDocument,
  splitLines,
  textFormat,
} from "./codex-integration-toml";

interface TomlTableRange {
  headerIndex: number;
  endIndex: number;
}

function findTomlTable(lines: string[], tableName: string): TomlTableRange | undefined {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`);
  const matches = lines
    .map((line, index) => header.test(line) ? index : -1)
    .filter(index => index >= 0);
  if (matches.length > 1) throw new Error(`Codex config contains duplicate [${tableName}] tables`);
  const headerIndex = matches[0];
  if (headerIndex === undefined) return undefined;
  const relativeEnd = lines
    .slice(headerIndex + 1)
    .findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return {
    headerIndex,
    endIndex: relativeEnd < 0 ? lines.length : headerIndex + 1 + relativeEnd,
  };
}

function insertFeatureTable(document: CodexConfigDocument): TomlTableRange {
  if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
    insertDocumentLine(document, document.lines.length, "");
  }
  insertDocumentLine(document, document.lines.length, "[features]");
  return findTomlTable(document.lines, "features")!;
}

function setScalarFeature(
  document: CodexConfigDocument,
  key: string,
  managedLine: string,
): void {
  const current = findFeatureAssignment(document.lines, key);
  if (current.index !== undefined) {
    document.lines[current.index] = managedLine;
    return;
  }
  const table = findTomlTable(document.lines, "features") ?? insertFeatureTable(document);
  insertDocumentLine(document, table.endIndex, managedLine);
}

function rawAssignmentInTable(
  lines: string[],
  tableName: "features" | "features.multi_agent_v2",
  key: string,
): PreviousFeatureAssignment {
  const table = findTomlTable(lines, tableName);
  if (!table) return { present: false, tablePresent: false, tableName };
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push({ present: true, rawLine: line, value: match[1]!, index });
  }
  if (matches.length > 1) {
    throw new Error(`Codex config contains duplicate [${tableName}].${key} assignments`);
  }
  return { ...(matches[0] ?? { present: false }), tablePresent: true, tableName };
}

function findBooleanAssignmentInTable(
  lines: string[],
  tableName: "features" | "features.multi_agent_v2",
  key: string,
): PreviousFeatureAssignment {
  const assignment = rawAssignmentInTable(lines, tableName, key);
  if (!assignment.present) return assignment;
  const value = stripTomlComment(assignment.value!).trim();
  if (value !== "true" && value !== "false") {
    throw new Error(`${key} in Codex [${tableName}] must be a boolean`);
  }
  return { ...assignment, value };
}

export function findAgentMaxDepthAssignment(lines: string[]): PreviousAgentAssignment {
  const table = findTomlTable(lines, "agents");
  if (!table) return { present: false, tablePresent: false };
  const regex = assignmentRegex("max_depth");
  const matches: PreviousAssignment[] = [];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    const value = stripTomlComment(match[1]!).trim().replaceAll("_", "");
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error("max_depth in Codex [agents] must be a positive integer");
    }
    matches.push({ present: true, rawLine: line, value, index });
  }
  if (matches.length > 1) throw new Error("Codex config contains duplicate [agents].max_depth assignments");
  return { ...(matches[0] ?? { present: false }), tablePresent: true };
}

function setAgentMaxDepth(document: CodexConfigDocument, value: number): void {
  const current = findAgentMaxDepthAssignment(document.lines);
  const managedLine = managedAgentMaxDepthLine(value);
  if (current.index !== undefined) {
    document.lines[current.index] = managedLine;
    return;
  }
  let table = findTomlTable(document.lines, "agents");
  if (!table) {
    if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
      insertDocumentLine(document, document.lines.length, "");
    }
    insertDocumentLine(document, document.lines.length, "[agents]");
    table = findTomlTable(document.lines, "agents")!;
  }
  let insertionIndex = table.endIndex;
  while (insertionIndex > table.headerIndex + 1 && document.lines[insertionIndex - 1]?.trim() === "") {
    insertionIndex -= 1;
  }
  insertDocumentLine(document, insertionIndex, managedLine);
}

export function findFeatureAssignment(lines: string[], key: string): PreviousFeatureAssignment {
  return findBooleanAssignmentInTable(lines, "features", key);
}

export function findMultiAgentV2Assignment(lines: string[]): PreviousFeatureAssignment {
  const rawScalar = rawAssignmentInTable(lines, "features", "multi_agent_v2");
  const table = findTomlTable(lines, "features.multi_agent_v2");
  if (rawScalar.present && table) {
    throw new Error(
      "Codex config defines multi_agent_v2 as both [features] scalar and [features.multi_agent_v2] table",
    );
  }
  if (table) return findBooleanAssignmentInTable(lines, "features.multi_agent_v2", "enabled");
  if (!rawScalar.present) return rawScalar;
  const scalarValue = stripTomlComment(rawScalar.value!).trim();
  if (scalarValue === "true" || scalarValue === "false") return { ...rawScalar, value: scalarValue };
  const inline = parseInlineBooleanField(rawScalar.value!, "multi_agent_v2");
  if (!inline) throw new Error("multi_agent_v2 in Codex [features] must be a boolean or inline table");
  return { ...rawScalar, value: inline.value, inlineTable: true };
}

export function installCompatibilityV1Features(text: string): {
  text: string;
  previousMultiAgent: PreviousFeatureAssignment;
  previousMultiAgentV2: PreviousFeatureAssignment;
  previousAgentMaxDepth: PreviousAgentAssignment;
  installedAgentMaxDepth: number;
} {
  const document = parseDocument(text);
  const foundMultiAgent = findFeatureAssignment(document.lines, "multi_agent");
  const featureSeparatorInserted = !foundMultiAgent.tablePresent
    && document.lines.length > 0
    && Boolean(document.lines.at(-1)?.trim());
  const previousMultiAgent: PreviousFeatureAssignment = featureSeparatorInserted
    ? { ...foundMultiAgent, separatorInserted: true }
    : foundMultiAgent;
  const previousMultiAgentV2 = findMultiAgentV2Assignment(document.lines);
  const foundAgentMaxDepth = findAgentMaxDepthAssignment(document.lines);
  const previousAgentMaxDepth: PreviousAgentAssignment = !foundAgentMaxDepth.tablePresent
    && document.lines.length > 0
    && Boolean(document.lines.at(-1)?.trim())
    ? { ...foundAgentMaxDepth, separatorInserted: true }
    : foundAgentMaxDepth;
  const installedAgentMaxDepth = Math.max(
    previousAgentMaxDepth.present ? Number(previousAgentMaxDepth.value) : 0,
    MIN_COMPATIBILITY_V1_AGENT_DEPTH,
  );
  setScalarFeature(document, "multi_agent", MANAGED_MULTI_AGENT_LINE);
  if (previousMultiAgentV2.inlineTable) {
    if (previousMultiAgentV2.index === undefined) {
      throw new Error("Codex [features].multi_agent_v2 inline table disappeared during setup");
    }
    document.lines[previousMultiAgentV2.index] = managedMultiAgentV2AssignmentLine(previousMultiAgentV2);
  } else if (previousMultiAgentV2.tableName === "features.multi_agent_v2") {
    const current = findBooleanAssignmentInTable(
      document.lines,
      "features.multi_agent_v2",
      "enabled",
    );
    if (current.index !== undefined) {
      document.lines[current.index] = MANAGED_MULTI_AGENT_V2_TABLE_LINE;
    } else {
      const table = findTomlTable(document.lines, "features.multi_agent_v2");
      if (!table) throw new Error("Codex [features.multi_agent_v2] table disappeared during setup");
      insertDocumentLine(document, table.endIndex, MANAGED_MULTI_AGENT_V2_TABLE_LINE);
    }
  } else {
    setScalarFeature(document, "multi_agent_v2", MANAGED_MULTI_AGENT_V2_LINE);
  }
  setAgentMaxDepth(document, installedAgentMaxDepth);
  return {
    text: renderDocument(document),
    previousMultiAgent,
    previousMultiAgentV2,
    previousAgentMaxDepth,
    installedAgentMaxDepth,
  };
}

function verifyInstalledBooleanFeature(
  text: string,
  key: string,
  expectedValue: "true" | "false",
  managedLine: string,
): void {
  const current = findFeatureAssignment(splitLines(text), key);
  if (current.value !== expectedValue || current.rawLine !== managedLine) {
    throw new Error(
      `Codex [features].${key} changed after setup; refusing to overwrite the user's newer value`,
    );
  }
}

function verifyInstalledMultiAgentV2Feature(
  text: string,
  previous: PreviousFeatureAssignment,
): void {
  if (previous.inlineTable) {
    const current = findMultiAgentV2Assignment(splitLines(text));
    if (!current.inlineTable
      || current.value !== "false"
      || current.rawLine !== managedMultiAgentV2AssignmentLine(previous)) {
      throw new Error(
        "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
      );
    }
    return;
  }
  if (previous.tableName !== "features.multi_agent_v2") {
    const current = findMultiAgentV2Assignment(splitLines(text));
    if (current.tableName !== "features"
      || current.value !== "false"
      || current.rawLine !== MANAGED_MULTI_AGENT_V2_LINE) {
      throw new Error(
        "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
      );
    }
    return;
  }
  const lines = splitLines(text);
  if (findFeatureAssignment(lines, "multi_agent_v2").present) {
    throw new Error(
      "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
    );
  }
  const current = findBooleanAssignmentInTable(lines, "features.multi_agent_v2", "enabled");
  if (current.value !== "false" || current.rawLine !== MANAGED_MULTI_AGENT_V2_TABLE_LINE) {
    throw new Error(
      "Codex [features.multi_agent_v2].enabled changed after setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreBooleanFeature(
  text: string,
  key: string,
  expectedValue: "true" | "false",
  managedLine: string,
  previous: PreviousFeatureAssignment,
): string {
  verifyInstalledBooleanFeature(text, key, expectedValue, managedLine);
  const document = parseDocument(text);
  const current = findFeatureAssignment(document.lines, key);
  if (current.index === undefined) throw new Error(`Managed Codex ${key} is missing`);
  if (previous.present) {
    if (!previous.rawLine) {
      throw new Error(`Codex integration journal is missing the prior ${key} line`);
    }
    document.lines[current.index] = previous.rawLine;
  } else {
    removeDocumentLine(document, current.index);
    if (!previous.tablePresent) {
      const table = findTomlTable(document.lines, "features");
      if (!table) throw new Error("Managed Codex [features] table is missing");
      const remaining = document.lines
        .slice(table.headerIndex + 1, table.endIndex)
        .filter(line => line.trim().length > 0);
      if (remaining.length === 0) {
        const headerIndex = table.headerIndex;
        removeDocumentLine(document, headerIndex);
        if (previous.separatorInserted && document.lines[headerIndex - 1] === "") {
          removeDocumentLine(document, headerIndex - 1);
        }
      }
    }
  }
  return renderDocument(document);
}

export function restoreMultiAgentV2Feature(
  text: string,
  previous: PreviousFeatureAssignment,
): string {
  if (previous.inlineTable) {
    verifyInstalledMultiAgentV2Feature(text, previous);
    const document = parseDocument(text);
    const current = findMultiAgentV2Assignment(document.lines);
    if (current.index === undefined || !previous.rawLine) {
      throw new Error("Managed Codex multi_agent_v2 inline table is missing");
    }
    document.lines[current.index] = previous.rawLine;
    return renderDocument(document);
  }
  if (previous.tableName !== "features.multi_agent_v2") {
    return restoreBooleanFeature(
      text,
      "multi_agent_v2",
      "false",
      MANAGED_MULTI_AGENT_V2_LINE,
      previous,
    );
  }
  verifyInstalledMultiAgentV2Feature(text, previous);
  const document = parseDocument(text);
  const current = findBooleanAssignmentInTable(
    document.lines,
    "features.multi_agent_v2",
    "enabled",
  );
  if (current.index === undefined) throw new Error("Managed Codex multi_agent_v2.enabled is missing");
  if (previous.present) {
    if (!previous.rawLine) {
      throw new Error("Codex integration journal is missing the prior multi_agent_v2.enabled line");
    }
    document.lines[current.index] = previous.rawLine;
  } else {
    removeDocumentLine(document, current.index);
  }
  return renderDocument(document);
}

export function verifyInstalledFeatures(
  text: string,
  journal: LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5,
): void {
  verifyInstalledBooleanFeature(
    text,
    "remote_compaction_v2",
    "false",
    MANAGED_REMOTE_COMPACTION_LINE,
  );
  verifyInstalledBooleanFeature(text, "multi_agent", "true", MANAGED_MULTI_AGENT_LINE);
  if (journal.version === 6) {
    verifyInstalledMultiAgentV2Feature(text, journal.previousMultiAgentV2);
  }
}

export function verifyCompatibilityV1Features(
  text: string,
  previousMultiAgentV2: PreviousFeatureAssignment,
  installedAgentMaxDepth: number,
): void {
  verifyInstalledBooleanFeature(text, "multi_agent", "true", MANAGED_MULTI_AGENT_LINE);
  verifyInstalledMultiAgentV2Feature(text, previousMultiAgentV2);
  const depth = findAgentMaxDepthAssignment(splitLines(text));
  if (depth.value !== String(installedAgentMaxDepth)
    || depth.rawLine !== managedAgentMaxDepthLine(installedAgentMaxDepth)) {
    throw new Error(
      "Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreCompatibilityV1Features(
  text: string,
  previousMultiAgent: PreviousFeatureAssignment,
  previousMultiAgentV2: PreviousFeatureAssignment,
  previousAgentMaxDepth: PreviousAgentAssignment,
  installedAgentMaxDepth: number,
): string {
  let restored = restoreBooleanFeature(
    restoreMultiAgentV2Feature(text, previousMultiAgentV2),
    "multi_agent",
    "true",
    MANAGED_MULTI_AGENT_LINE,
    previousMultiAgent,
  );
  restored = restoreCompatibilityV1AgentDepth(
    restored,
    previousAgentMaxDepth,
    installedAgentMaxDepth,
  );
  return restored;
}

export function restoreCompatibilityV1AgentDepth(
  text: string,
  previousAgentMaxDepth: PreviousAgentAssignment,
  installedAgentMaxDepth: number,
): string {
  verifyCompatibilityV1AgentDepth(text, installedAgentMaxDepth);
  const document = parseDocument(text);
  const current = findAgentMaxDepthAssignment(document.lines);
  if (current.index === undefined) throw new Error("Managed Codex [agents].max_depth is missing");
  if (previousAgentMaxDepth.present) {
    if (!previousAgentMaxDepth.rawLine) {
      throw new Error("Codex integration journal is missing the prior [agents].max_depth line");
    }
    document.lines[current.index] = previousAgentMaxDepth.rawLine;
  } else {
    removeDocumentLine(document, current.index);
    if (!previousAgentMaxDepth.tablePresent) {
      const table = findTomlTable(document.lines, "agents");
      if (!table) throw new Error("Managed Codex [agents] table is missing");
      const remaining = document.lines
        .slice(table.headerIndex + 1, table.endIndex)
        .filter(line => line.trim().length > 0);
      if (remaining.length === 0) {
        const headerIndex = table.headerIndex;
        removeDocumentLine(document, headerIndex);
        if (previousAgentMaxDepth.separatorInserted && document.lines[headerIndex - 1] === "") {
          removeDocumentLine(document, headerIndex - 1);
        }
      }
    }
  }
  return renderDocument(document);
}

function verifyCompatibilityV1AgentDepth(text: string, installedAgentMaxDepth: number): void {
  const depth = findAgentMaxDepthAssignment(splitLines(text));
  if (depth.value !== String(installedAgentMaxDepth)
    || depth.rawLine !== managedAgentMaxDepthLine(installedAgentMaxDepth)) {
    throw new Error(
      "Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreManagedFeatures(
  text: string,
  journal: LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5,
): string {
  const withoutMultiAgentV2 = journal.version === 6
    ? restoreMultiAgentV2Feature(text, journal.previousMultiAgentV2)
    : text;
  const withoutMultiAgent = restoreBooleanFeature(
    withoutMultiAgentV2,
    "multi_agent",
    "true",
    MANAGED_MULTI_AGENT_LINE,
    journal.previousMultiAgent,
  );
  return restoreBooleanFeature(
    withoutMultiAgent,
    "remote_compaction_v2",
    "false",
    MANAGED_REMOTE_COMPACTION_LINE,
    journal.previousRemoteCompactionV2,
  );
}
