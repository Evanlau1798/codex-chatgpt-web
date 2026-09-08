import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const git = (...args: string[]) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
}).trim();

const ledger = JSON.parse(readFileSync(
  new URL("../.github/upstream-audit/v5.0.5.json", import.meta.url),
  "utf8",
)) as {
  baseline: { forkCommit: string; upstream: string };
  upstream: { tagObject: string; commit: string };
  closure: { expectedPaths: number; classifiedPaths: number; missingPaths: number; status: string };
  candidate: { commit: string; tree: string };
  entries: Array<{
    path: string;
    classification: string;
    reason: string;
    tests: string[];
    candidateBlob: string | null;
    source: { targetBlob: string };
  }>;
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

test("v5.0.5 audit binds every candidate blob to the fixed release tree", () => {
  expect(git("rev-parse", `${ledger.candidate.commit}^{tree}`)).toBe(ledger.candidate.tree);
  expect(() => git("merge-base", "--is-ancestor", ledger.candidate.commit, "HEAD")).not.toThrow();
  expect(git("diff", "--name-only", ledger.candidate.commit, "HEAD").split(/\r?\n/).filter(Boolean)).toEqual([
    ".github/upstream-audit/v5.0.5.json",
    "tests/upstream-audit-v505.test.ts",
  ]);

  const tree = new Map(git("ls-tree", "-r", ledger.candidate.commit).split(/\r?\n/).map(line => {
    const [header, path] = line.split("\t");
    return [path, header!.split(" ")[2]];
  }));
  for (const entry of ledger.entries) {
    expect(tree.get(entry.path) ?? null, entry.path).toBe(entry.candidateBlob);
    if (entry.classification === "exact") {
      expect(entry.candidateBlob, entry.path).toBe(entry.source.targetBlob);
    }
  }
});
