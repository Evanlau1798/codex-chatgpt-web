import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ledger = JSON.parse(readFileSync(
  new URL("../.github/upstream-audit/v5.0.5.json", import.meta.url),
  "utf8",
)) as {
  baseline: { forkCommit: string; upstream: string };
  upstream: { tagObject: string; commit: string };
  closure: { expectedPaths: number; classifiedPaths: number; missingPaths: number; status: string };
  entries: Array<{ path: string; classification: string; reason: string; tests: string[] }>;
  merge: { commit: string; parents: string[]; strategy: string; rerereEnabled: boolean };
  mergeEvidence: { archive: string; sha256: string; bytes: number; automaticTree: string };
};

test("v5.0.5 upstream audit closes every pinned path with original merge evidence", () => {
  expect(ledger.upstream).toMatchObject({
    tagObject: "dd254f2e1a67c9d11326533bc150549c6ff95da6",
    commit: "0b053b6750b1d4f127619765388eb43c6d212ca2",
  });
  expect(ledger.closure).toEqual({
    expectedPaths: 42,
    classifiedPaths: 42,
    missingPaths: 0,
    status: "complete",
  });
  expect(new Set(ledger.entries.map(entry => entry.path)).size).toBe(42);
  expect(ledger.entries.every(entry => (
    ["exact", "adapted", "superseded", "rejected"].includes(entry.classification)
    && entry.reason.length > 20
  ))).toBeTrue();
  expect(ledger.merge).toMatchObject({
    commit: "346ef7e9d7a0cfb822ae203a8653bc8b6aa4966a",
    parents: ["30035cb854d4c9604c9b62bc43e70d1ddf1dba2e", ledger.upstream.commit],
    strategy: "ort",
    rerereEnabled: false,
  });

  const archive = readFileSync(new URL(`../${ledger.mergeEvidence.archive}`, import.meta.url));
  expect(archive.length).toBe(ledger.mergeEvidence.bytes);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(ledger.mergeEvidence.sha256);
  expect(ledger.mergeEvidence.automaticTree).toBe("1871418e82ba9f5dc5a97ec774d5f9370117bc8c");
});
