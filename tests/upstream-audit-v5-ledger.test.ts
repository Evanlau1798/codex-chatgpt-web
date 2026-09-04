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
  semanticReview: {
    scope: string;
    remainingScope: string;
    completeRelease: boolean;
    obligations: Array<{
      id: string;
      classification: Classification;
      behavior: string;
      interface: string;
      source: { path: string; symbol: string; anchor: string };
      implementation: string;
      tests: Array<{ path: string; assertion: string }>;
    }>;
  };
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

  test("reopened manual obligations have specific source and assertion links, not just path coverage", () => {
    const review = ledger.semanticReview;
    expect(review).toBeDefined();
    expect(review.scope.length).toBeGreaterThan(0);
    if (!review.completeRelease) {
      expect(review.remainingScope.length).toBeGreaterThan(0);
      expect(ledger.closure.status).toBe("obligations-recorded");
    }
    expect(review.obligations.map(item => item.id).sort()).toEqual([
      "automatic-effort-activation", "automatic-submission-recovery", "automatic-surface-readiness", "automatic-tool-observation",
      "broker-frame-settlement", "codex-inline-table", "codex-voice-route",
      "cumulative-recompaction",
      "dev-chat-readiness", "dev-chat-saved-model",
      "dev-setup-interaction",
      "enhanced-compaction-physical-settlement",
      "environment-cwdless",
      "interaction-mode-http-drain",
      "launcher-foreground-request", "launcher-interaction-operations",
      "manual-body-limit", "manual-clipboard-transaction", "manual-compaction-canonical", "manual-compaction-reconnect", "manual-duplicate-deadline",
      "manual-mcp-contract",
      "manual-mode-transaction",
      "manual-native-owner",
      "manual-navigation-superseded",
      "manual-owner-death", "manual-owner-liveness", "manual-primary-surface", "manual-provider-catalog", "manual-resume-validation",
      "manual-retained-ttl", "manual-supervisor-identity", "manual-surface-failure", "manual-terminal-errors", "manual-tool-boundary", "manual-ui-close",
      "markdown-wiki-links",
      "setup-preflight", "setup-profile-checkpoint", "setup-profile-migration", "setup-runtime-change", "supervisor-boot-ownership", "tunnel-command-contract", "tunnel-key-isolation",
    ]);
    const sources = new Map<string, string>();
    for (const item of review.obligations) {
      expect(item.classification).toBe("adapted");
      expect(item.behavior.length).toBeGreaterThan(0);
      expect(item.interface.length).toBeGreaterThan(0);
      expect(ledger.entries.some(entry => entry.path === item.source.path)).toBeTrue();
      if (!sources.has(item.source.path)) {
        const source = spawnSync("git", ["show", `${ledger.upstream.commit}:${item.source.path}`], {
          cwd: repositoryRoot, encoding: "utf8",
        });
        expect(source.status).toBe(0);
        sources.set(item.source.path, source.stdout);
      }
      expect(item.source.anchor.length).toBeGreaterThan(0);
      expect(sources.get(item.source.path)).toContain(`${item.source.symbol}(`);
      expect(sources.get(item.source.path)).toContain(item.source.anchor);
      expect(readFileSync(resolve(repositoryRoot, item.implementation), "utf8").length).toBeGreaterThan(0);
      expect(item.tests.length).toBeGreaterThan(0);
      for (const mapped of item.tests) {
        expect(mapped.assertion).toMatch(/assert\.|expect\(/);
        expect(readFileSync(resolve(repositoryRoot, mapped.path), "utf8").replace(/\r\n/g, "\n"))
          .toContain(mapped.assertion);
      }
    }
  });
});
