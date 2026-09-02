import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type LedgerEntry = {
  id: string;
  path: string;
  changeType: string;
  source: { commit: string; parentBlob: string | null; targetBlob: string };
  classification: "exact" | "adapted" | "superseded" | "rejected" | "missing";
  reason: string;
  evidence: string[];
  surfaces: string[];
};

type Ledger = {
  schemaVersion: number;
  release: string;
  targetVersion: string;
  upstream: { tagObject: string; commit: string; sourceRange: string };
  baseline: { upstreamRangeBase: string };
  closure: { status: string; expectedPathCount: number };
  entries: LedgerEntry[];
};

type PublicationReceipt = {
  integration: { githubMerge: string };
  ledger: { path: string; blob: string; sha256: string };
};

const repositoryRoot = resolve(import.meta.dir, "..");

const ledger = JSON.parse(readFileSync(
  resolve(repositoryRoot, ".github", "upstream-audit", "v4.0.8.json"),
  "utf8",
)) as Ledger;
const publication = JSON.parse(readFileSync(
  resolve(repositoryRoot, ".github", "upstream-audit", "v4.0.8-publication.json"),
  "utf8",
)) as PublicationReceipt;
const sha = /^[0-9a-f]{40}$/;

describe("upstream v4.0.8 audit ledger", () => {
  test("pins the annotated release identity", () => {
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.release).toBe("v4.0.8");
    expect(ledger.targetVersion).toBe("4.0.8-Enhanced.1");
    expect(ledger.upstream.tagObject).toBe("3d52f25724c604d5aa580336f9169ebb9c9e4ec3");
    expect(ledger.upstream.commit).toBe("bd535d8359cf1980de2b449a7d3b79af97862226");
  });

  test("classifies every changed path exactly once", () => {
    expect(ledger.entries).toHaveLength(ledger.closure.expectedPathCount);
    expect(new Set(ledger.entries.map(entry => entry.path)).size).toBe(ledger.entries.length);
    expect(new Set(ledger.entries.map(entry => entry.id)).size).toBe(ledger.entries.length);
    for (const entry of ledger.entries) {
      expect(entry.source.commit).toMatch(sha);
      expect(entry.source.targetBlob).toMatch(sha);
      if (entry.source.parentBlob !== null) expect(entry.source.parentBlob).toMatch(sha);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.surfaces.length).toBeGreaterThan(0);
      expect(entry.classification).not.toBe("missing");
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
    expect(ledger.closure.status).toBe("candidate-complete");
  });

  test("mechanically covers the complete raw upstream delta", () => {
    const diff = spawnSync("git", [
      "--no-pager", "diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
      `${ledger.baseline.upstreamRangeBase}..${ledger.upstream.commit}`, "--",
    ], { cwd: resolve(import.meta.dir, ".."), encoding: "utf8" });
    expect(diff.status).toBe(0);
    const paths = diff.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const match = line.match(/^:[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\t(.+)$/);
      if (!match) throw new Error(`Unexpected raw diff record: ${line}`);
      return { changeType: match[1], path: match[2] };
    });
    expect(paths).toEqual(ledger.entries.map(({ changeType, path }) => ({ changeType, path })));
  });

  test("binds the publication receipt to canonical Git blob bytes", () => {
    const committedBlob = spawnSync("git", [
      "rev-parse", `${publication.integration.githubMerge}:${publication.ledger.path}`,
    ], { cwd: repositoryRoot, encoding: "utf8" });
    expect(committedBlob.status).toBe(0);
    expect(committedBlob.stdout.trim()).toBe(publication.ledger.blob);

    const blob = spawnSync("git", ["cat-file", "blob", publication.ledger.blob], {
      cwd: repositoryRoot,
    });
    expect(blob.status).toBe(0);
    expect(createHash("sha256").update(blob.stdout).digest("hex"))
      .toBe(publication.ledger.sha256);
  });
});
