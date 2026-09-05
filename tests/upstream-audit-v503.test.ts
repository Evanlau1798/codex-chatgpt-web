import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(resolve(root, ".github/upstream-audit/v5.0.3.json"), "utf8"));
function git(...args: string[]): string {
  const child = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trimEnd();
}

test("v5.0.3 closes the pinned upstream delta without rewriting inherited evidence", () => {
  expect(ledger.upstream.commit).toBe("74aed4025937eadca13b363cdcbc87963cd4dff3");
  expect(ledger.upstream.tagObject).toBe("5d1eec188a6a009ef1f86ee508f4b48069903560");
  expect(ledger.closure.status).toBe("candidate-complete");
  const paths = git("diff", "--name-only", ledger.baseline.upstream, ledger.upstream.commit).split(/\r?\n/);
  const sourceBlobs = new Map(git("ls-tree", "-r", ledger.upstream.commit).split(/\r?\n/).map(line => {
    const [header, file] = line.split("\t");
    return [file, header!.split(" ")[2]];
  }));
  expect(ledger.entries.map((entry: { path: string }) => entry.path)).toEqual(paths);
  expect(paths).toHaveLength(41);
  for (const entry of ledger.entries) {
    expect(entry.classification).not.toBe("missing");
    expect(entry.reason.length).toBeGreaterThan(20);
    expect(entry.tests.length).toBeGreaterThan(0);
    for (const file of entry.tests) expect(ledger.assertionMap[file]?.length).toBeGreaterThan(0);
    expect(sourceBlobs.get(entry.path)).toBe(entry.source.targetBlob);
    if (entry.classification === "exact") expect(entry.candidateBlob).toBe(entry.source.targetBlob);
  }
  expect(ledger.baseline.inheritedLimitation).toContain("v5.0.0");
});

test("original v5.0.3 conflict snapshot remains immutable and content-only", () => {
  const file = resolve(root, ledger.mergeEvidence.archive);
  const archive = readFileSync(file);
  expect(archive.length).toBe(ledger.mergeEvidence.bytes);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(ledger.mergeEvidence.sha256);
  const listing = spawnSync("tar", ["-tzf", file], { encoding: "utf8" });
  expect(listing.status).toBe(0);
  expect(listing.stdout).toContain("automatic-changed-paths.tar");
  expect(listing.stdout).toContain("index-stages.txt");
  expect(listing.stdout).not.toMatch(/user-gitignore|storage-state|\.log/);
  const snapshot = spawnSync("tar", ["-xOzf", file, "snapshot.json"], { encoding: "utf8" });
  expect(snapshot.status).toBe(0);
  const evidence = JSON.parse(snapshot.stdout);
  expect(evidence.kind).toBe("contemporaneous-pre-resolution");
  expect(evidence.mergeHead).toBe(ledger.upstream.commit);
  expect(evidence.mergeFirstParent).toBe(ledger.baseline.forkCommit);
  expect(evidence.automaticTree).toBe(ledger.mergeEvidence.automaticTree);
});

test("v5.0.3 assertion mappings are executable against immutable candidate blobs", () => {
  // Git objects are retained by the integration ancestry, not compared to a later release's files.
  for (const [file, anchors] of Object.entries(ledger.assertionMap) as [string, string[]][]) {
    const blob = ledger.assertionBlobs[file];
    expect(blob, file).toMatch(/^[0-9a-f]{40}$/);
    const source = git("cat-file", "blob", blob).replace(/\r\n/g, "\n");
    for (const anchor of anchors) expect(source, file).toContain(anchor);
  }
}, 30_000);
