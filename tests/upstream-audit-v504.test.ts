import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(resolve(root, ".github/upstream-audit/v5.0.4.json"), "utf8"));

function git(...args: string[]): string {
  const child = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trimEnd();
}

test("v5.0.4 closes every pinned upstream path obligation", () => {
  expect(ledger.upstream.tagObject).toBe("175599208e8f1283da81259c5466989eece49e52");
  expect(ledger.upstream.commit).toBe("c648c09501bb1b704c7ad5273fb5f5d6b8992dd2");
  expect(ledger.closure.status).toBe("candidate-complete");
  const paths = git("diff", "--name-only", ledger.baseline.upstream, ledger.upstream.commit).split(/\r?\n/);
  expect(ledger.entries.map((entry: { path: string }) => entry.path)).toEqual(paths);
  expect(paths).toHaveLength(ledger.closure.expectedPaths);
  for (const entry of ledger.entries) {
    expect(entry.classification).not.toBe("missing");
    expect(entry.reason.length).toBeGreaterThan(30);
    expect(entry.implementation.length).toBeGreaterThan(0);
    expect(entry.tests.length).toBeGreaterThan(0);
    expect(git("rev-parse", `${ledger.baseline.upstream}:${entry.path}`)).toBe(entry.source.parentBlob);
    expect(git("rev-parse", `${ledger.upstream.commit}:${entry.path}`)).toBe(entry.source.targetBlob);
    expect(git("cat-file", "-t", entry.candidateBlob)).toBe("blob");
    for (const file of [...entry.implementation, ...entry.tests]) {
      expect(existsSync(resolve(root, file)), file).toBeTrue();
    }
    if (entry.classification === "exact") expect(entry.candidateBlob).toBe(entry.source.targetBlob);
  }
  expect(ledger.closure.classifications).toEqual({ adapted: 18, exact: 1, superseded: 1, rejected: 1 });
});

test("v5.0.4 preserves the original merge evidence and upstream object closure", () => {
  const archive = readFileSync(resolve(root, ledger.mergeEvidence.archive));
  expect(archive.length).toBe(ledger.mergeEvidence.bytes);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(ledger.mergeEvidence.sha256);
  const listing = spawnSync("tar", ["-tzf", resolve(root, ledger.mergeEvidence.archive)], { encoding: "utf8" });
  expect(listing.status, listing.stderr).toBe(0);
  for (const name of ["snapshot.json", "index-stages.txt", "automatic-changed-paths.tar", "upstream-v5.0.4.bundle"]) {
    expect(listing.stdout).toContain(name);
  }
  expect(listing.stdout).not.toMatch(/storage-state|user-gitignore|\.log/);
  const snapshot = spawnSync("tar", ["-xOzf", resolve(root, ledger.mergeEvidence.archive), "./snapshot.json"], { encoding: "utf8" });
  expect(snapshot.status, snapshot.stderr).toBe(0);
  const evidence = JSON.parse(snapshot.stdout);
  expect(evidence).toMatchObject({
    kind: "contemporaneous-pre-resolution",
    mergeFirstParent: ledger.baseline.forkCommit,
    mergeHead: ledger.upstream.commit,
    tagObject: ledger.upstream.tagObject,
    automaticTree: ledger.mergeEvidence.automaticTree,
  });
});
