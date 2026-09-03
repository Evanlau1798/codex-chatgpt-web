import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Classification = "exact" | "adapted" | "superseded" | "rejected" | "missing";
type Ledger = {
  schemaVersion: number;
  release: string;
  targetVersion: string;
  baseline: { forkCommit: string; mergeBase: string };
  upstream: { tagObject: string; commit: string; sourceRange: string };
  closure: { status: "obligations-recorded" | "candidate-complete"; expectedPathCount: number };
  entries: Array<{
    id: string;
    path: string;
    changeType: string;
    source: { commit: string; parentBlob: string | null; targetBlob: string };
    localBaselineBlob: string | null;
    classification: Classification;
    reason: string;
    evidence: string[];
    surfaces: string[];
  }>;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(
  resolve(repositoryRoot, ".github", "upstream-audit", "v5.0.0.json"),
  "utf8",
)) as Ledger;
const sha = /^[0-9a-f]{40}$/;

describe("upstream v5.0.0 audit ledger", () => {
  test("pins the release and canonical merge base", () => {
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.release).toBe("v5.0.0");
    expect(ledger.targetVersion).toBe("5.0.0-Enhanced.1");
    expect(ledger.baseline.forkCommit).toBe("1e6f0289eec32e062dfe208c6dc627b6c73a6e0a");
    expect(ledger.baseline.mergeBase).toBe("bd535d8359cf1980de2b449a7d3b79af97862226");
    expect(ledger.upstream.tagObject).toBe("817080b1d185760b57741a59080a2c16aa4ae4b9");
    expect(ledger.upstream.commit).toBe("b2793cfd22342b0c6409df5eb855c163cefc16ea");
  });

  test("records every upstream path exactly once", () => {
    expect(ledger.entries).toHaveLength(ledger.closure.expectedPathCount);
    expect(new Set(ledger.entries.map(entry => entry.id)).size).toBe(ledger.entries.length);
    expect(new Set(ledger.entries.map(entry => entry.path)).size).toBe(ledger.entries.length);
    for (const entry of ledger.entries) {
      expect(entry.source.commit).toMatch(sha);
      expect(entry.source.targetBlob).toMatch(sha);
      if (entry.source.parentBlob !== null) expect(entry.source.parentBlob).toMatch(sha);
      if (entry.localBaselineBlob !== null) expect(entry.localBaselineBlob).toMatch(sha);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.surfaces.length).toBeGreaterThan(0);
    }
    if (ledger.closure.status === "candidate-complete") {
      expect(ledger.entries.some(entry => entry.classification === "missing")).toBeFalse();
    }
  });

  test("matches the complete binary-capable upstream delta", () => {
    const diff = spawnSync("git", [
      "--no-pager", "diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
      ledger.upstream.sourceRange, "--",
    ], { cwd: repositoryRoot, encoding: "utf8" });
    expect(diff.status).toBe(0);
    const paths = diff.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const match = line.match(/^:[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\t(.+)$/);
      if (!match) throw new Error(`Unexpected raw diff record: ${line}`);
      return { changeType: match[1], path: match[2] };
    });
    expect(paths).toEqual(ledger.entries.map(({ changeType, path }) => ({ changeType, path })));
  });

  test("candidate blob claims match the current audited implementation", () => {
    for (const entry of ledger.entries) {
      const claim = entry.evidence.find(value => value.startsWith("candidate-blob:"));
      if (!claim && entry.classification !== "exact") continue;
      const hashed = spawnSync("git", ["hash-object", entry.path], {
        cwd: repositoryRoot, encoding: "utf8",
      });
      expect(hashed.status, entry.path).toBe(0);
      expect(hashed.stdout.trim(), entry.path).toBe(
        entry.classification === "exact" ? entry.source.targetBlob : claim!.slice("candidate-blob:".length),
      );
    }
  });
});
