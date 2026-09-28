import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const ledgerPath = resolve(root, ".github/upstream-audit/v6.1.2.json");
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
  baseline: string;
  semanticBaseline: string;
  upstream: string;
  automaticMergeTree: string;
  coverage: {
    paths: number;
    hunks: number;
    changedTests: number;
    mappedPaths: number;
    pending: number;
    missing: number;
  };
  evidence: {
    path: string;
    sha256: string;
    autoMergeTrees: Record<string, string>;
  };
  pathGroups: Array<{ paths: string[] }>;
  changedTests: string[];
};

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!rawName) break;
    const name = rawName.replace(/^\.\//, "");
    const rawSize = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(rawSize || "0", 8);
    const start = offset + 512;
    entries.set(name, tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function git(args: string[], cwd = root): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

test("v6.1.2 audit closes the exact upstream path and test delta", () => {
  expect(ledger.baseline).toBe("fa514a4630e322c9dd50ac2345956b2b64918821");
  expect(ledger.semanticBaseline).toBe("a13cd09950969f43e3b7e25c71fa43efaf5446c5");
  expect(ledger.upstream).toBe("2d73f626290a5062825bb595dabb89aaf88d16c5");
  expect(ledger.coverage).toEqual({
    paths: 45,
    hunks: 122,
    changedTests: 12,
    mappedPaths: 45,
    pending: 0,
    missing: 0,
  });

  const expectedPaths = git([
    "diff",
    "--name-only",
    `${ledger.semanticBaseline}..${ledger.upstream}`,
  ]).split(/\r?\n/).filter(Boolean).sort();
  const mappedPaths = ledger.pathGroups.flatMap(group => group.paths).sort();
  expect(mappedPaths).toEqual(expectedPaths);
  expect(new Set(mappedPaths).size).toBe(mappedPaths.length);
  expect(ledger.changedTests).toEqual(expectedPaths.filter(path =>
    /(^|\/)(tests?|__tests__)\/|\.test\./.test(path)
  ));
});

test("v6.1.2 evidence archive is content-addressed and reconstructs every AUTO_MERGE tree", () => {
  const archive = readFileSync(resolve(root, ledger.evidence.path));
  expect(createHash("sha256").update(archive).digest("hex")).toBe(ledger.evidence.sha256);
  const entries = tarEntries(archive);
  for (const required of [
    "manifest.json",
    "objects/auto-merge-objects.pack",
    "prior/v6.1.0/ledger.md",
    "prior/v6.1.0/merge-identity.txt",
    "prior/v6.1.1/ledger.json",
    "prior/v6.1.1/original-merge/manifest.json",
    "prior/v6.1.1/original-merge/metadata.json",
    "current/original-merge/auto-merge.txt",
    "current/resolution-vs-B.patch",
  ]) {
    expect(entries.has(required)).toBeTrue();
  }

  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
    autoMergeTrees: Record<string, string>;
  };
  expect(manifest.autoMergeTrees).toEqual(ledger.evidence.autoMergeTrees);
  for (const item of manifest.files) {
    const content = entries.get(item.path);
    expect(content, item.path).toBeDefined();
    expect(content!.byteLength, item.path).toBe(item.bytes);
    expect(createHash("sha256").update(content!).digest("hex"), item.path).toBe(item.sha256);
  }

  const scratch = mkdtempSync(resolve(tmpdir(), "upstream-audit-v612-"));
  try {
    git(["init", "--bare", scratch]);
    const packPath = resolve(scratch, "objects/pack/auto-merge-objects.pack");
    mkdirSync(dirname(packPath), { recursive: true });
    writeFileSync(packPath, entries.get("objects/auto-merge-objects.pack")!);
    git(["--git-dir", scratch, "index-pack", packPath]);
    for (const tree of Object.values(ledger.evidence.autoMergeTrees)) {
      expect(git(["--git-dir", scratch, "cat-file", "-t", tree])).toBe("tree");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
