import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const ledger = JSON.parse(readFileSync(
  new URL("../.github/upstream-audit/v5.0.6.json", import.meta.url), "utf8",
)) as {
  upstream: { tagObject: string; commit: string };
  closure: { expectedPaths: number; classifiedPaths: number; missingPaths: number; status: string };
  candidate: { commit: string; tree: string };
  entries: Array<{ path: string; classification: string; reason: string; candidateBlob: string | null; source: { targetBlob: string | null } }>;
  merge: { commit: string; parents: string[]; strategy: string; rerereEnabled: boolean };
  mergeEvidence: { archive: string; sha256: string; bytes: number; automaticTree: string };
};

test("v5.0.6 audit closes every pinned path with original merge evidence", () => {
  expect(ledger.upstream).toMatchObject({
    tagObject: "24250dcf13961b45c2ee6794112c7e77461bde73",
    commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
  });
  expect(ledger.closure).toEqual({ expectedPaths: 34, classifiedPaths: 34, missingPaths: 0, status: "complete" });
  expect(new Set(ledger.entries.map(entry => entry.path)).size).toBe(34);
  expect(ledger.entries.every(entry => ["exact", "adapted", "superseded", "rejected"].includes(entry.classification)
    && entry.reason.length > 20)).toBeTrue();
  expect(ledger.merge).toMatchObject({
    commit: ledger.candidate.commit,
    parents: ["ad94876d96ca4195321b98cdbb87c919250062f0", ledger.upstream.commit],
    strategy: "ort",
    rerereEnabled: false,
  });
  const archive = readFileSync(new URL(`../${ledger.mergeEvidence.archive}`, import.meta.url));
  expect(archive.length).toBe(ledger.mergeEvidence.bytes);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(ledger.mergeEvidence.sha256);
  expect(ledger.mergeEvidence.automaticTree).toBe("6f438e6eb3edb731e82f44115b5614e74c1f2938");
});

test("v5.0.6 audit binds every candidate blob to the fixed release tree", () => {
  expect(git("rev-parse", `${ledger.candidate.commit}^{tree}`)).toBe(ledger.candidate.tree);
  expect(() => git("merge-base", "--is-ancestor", ledger.upstream.commit, ledger.candidate.commit)).not.toThrow();
  const tree = new Map(git("ls-tree", "-r", ledger.candidate.commit).split(/\r?\n/).map(line => {
    const [header, path] = line.split("\t");
    return [path, header!.split(" ")[2]];
  }));
  for (const entry of ledger.entries) {
    expect(tree.get(entry.path) ?? null, entry.path).toBe(entry.candidateBlob);
    if (entry.classification === "exact") expect(entry.candidateBlob, entry.path).toBe(entry.source.targetBlob);
  }
});
