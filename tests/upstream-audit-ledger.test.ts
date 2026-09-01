import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  closure: { expectedPathCount: number };
  entries: LedgerEntry[];
};

const ledger = JSON.parse(readFileSync(
  resolve(import.meta.dir, "..", ".github", "upstream-audit", "v4.0.8.json"),
  "utf8",
)) as Ledger;
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
    }
  });
});
