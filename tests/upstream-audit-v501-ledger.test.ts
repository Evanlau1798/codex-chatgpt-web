import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

type Entry = {
  path: string;
  changeType: string;
  source: { targetBlob: string };
  candidateBlob: string | null;
  classification: "exact" | "adapted" | "superseded" | "rejected" | "missing";
  reason: string;
  assertions: Array<{ path: string; contains: string }>;
};

const root = resolve(import.meta.dir, "..");
let archiveIndex: { bytes: Buffer; tag: string; listing: string } | undefined;
// Historical receipts prove their published candidate, not every future working tree.
const publishedLedgerCommit = JSON.parse(readFileSync(
  resolve(root, ".github/upstream-audit/v5.0.1-publication.json"), "utf8",
)).ledger.commit as string;
const ledger = JSON.parse(readFileSync(
  resolve(root, ".github/upstream-audit/v5.0.1.json"),
  "utf8",
)) as {
  release: string;
  targetVersion: string;
  baseline: { forkCommit: string; upstream: string };
  upstream: { tagObject: string; commit: string; sourceRange: string };
  closure: { expectedPaths: number; status: string; classifications: Record<string, number> };
  entries: Entry[];
  mergeEvidence: {
    kind: string;
    archive: string;
    inheritedLimitation: string;
    sha256: string;
    bytes: number;
  };
};

function git(args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function indexedArchive() {
  if (archiveIndex) return archiveIndex;
  const bytes = readFileSync(resolve(root, ledger.mergeEvidence.archive));
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const names: string[] = [];
  let tag: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start: number, end: number) => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    const prefix = text(345, 500), name = (prefix ? `${prefix}/` : "") + text(0, 100);
    const sizeText = text(124, 136).trim(), checksumText = text(148, 156).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(checksumText)) throw new Error("Invalid audit tar header");
    const size = Number.parseInt(sizeText, 8), expectedChecksum = Number.parseInt(checksumText, 8);
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    const start = offset + 512, end = start + size;
    if (checksum !== expectedChecksum || !Number.isSafeInteger(end) || end > tar.length) throw new Error("Invalid audit tar entry");
    names.push(name);
    if (name === "upstream-tag.txt") {
      if (tag !== undefined || ![0, 48].includes(header[156]!)) throw new Error("Invalid duplicate audit tag entry");
      tag = tar.subarray(start, end).toString("utf8");
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (tag === undefined) throw new Error("Missing audit upstream tag");
  return archiveIndex = { bytes, tag, listing: names.join("\n") };
}

test("v5.0.1 ledger pins the exact release and contemporaneous merge evidence", () => {
  expect(ledger.release).toBe("v5.0.1");
  expect(ledger.targetVersion).toBe("5.0.1-Enhanced.1");
  expect(ledger.baseline).toMatchObject({
    forkCommit: "eef6d28680a88eea48864a4391921137dbeb554c",
    upstream: "b2793cfd22342b0c6409df5eb855c163cefc16ea",
  });
  expect(ledger.upstream).toMatchObject({
    tagObject: "4473f90a1f09348eb52d0db36d283550653ea62a",
    commit: "9a7428a9d1fced9baaa85112994c02c011a3b7c9",
  });
  const { tag } = indexedArchive();
  expect(git(["hash-object", "-t", "tag", "--stdin"], tag)).toBe(ledger.upstream.tagObject);
  expect(tag).toStartWith(`object ${ledger.upstream.commit}\ntype commit\ntag ${ledger.release}\n`);
  expect(ledger.mergeEvidence.kind).toBe("contemporaneous-default-ort");
  expect(ledger.mergeEvidence.inheritedLimitation).toContain("v5.0.0");
}, 15_000);

test("v5.0.1 public evidence archive is complete and excludes private state", () => {
  const { bytes, listing } = indexedArchive();
  expect(bytes.byteLength).toBe(ledger.mergeEvidence.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(ledger.mergeEvidence.sha256);
  expect(listing).toContain("object-closure-verification.txt");
  expect(listing).toContain("resolution-map.json");
  expect(listing).not.toContain("user-gitignore.patch");
});

test("v5.0.1 ledger closes every binary-capable path obligation", () => {
  const raw = git([
    "diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv",
    ledger.upstream.sourceRange, "--",
  ]).split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^:[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\t(.+)$/);
    if (!match) throw new Error(`Unexpected raw diff record: ${line}`);
    return { changeType: match[1], path: match[2] };
  });
  expect(ledger.entries).toHaveLength(ledger.closure.expectedPaths);
  expect(ledger.entries.map(({ changeType, path }) => ({ changeType, path }))).toEqual(raw);
  expect(new Set(ledger.entries.map(entry => entry.path)).size).toBe(ledger.entries.length);
  expect(ledger.entries.some(entry => entry.classification === "missing")).toBeFalse();
  expect(ledger.closure.status).toBe("candidate-complete");
  const counts: Record<string, number> = {};
  for (const entry of ledger.entries) {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }
  expect(counts).toEqual({ adapted: 51, exact: 3, superseded: 1 });
  expect(ledger.closure.classifications).toMatchObject({ ...counts, rejected: 0, missing: 0 });
});

test("v5.0.1 candidate blobs and upstream test mappings remain executable", () => {
  const present = ledger.entries.filter(entry => entry.candidateBlob !== null);
  const tree = new Map(git(["ls-tree", "-r", publishedLedgerCommit]).split(/\r?\n/).map(line => {
    const [header, path] = line.split("\t");
    return [path, header!.split(" ")[2]];
  }));
  const hashes = present.map(entry => tree.get(entry.path));
  expect(hashes).toHaveLength(present.length);
  for (const [index, entry] of present.entries()) {
    const candidateBlob = entry.candidateBlob;
    if (candidateBlob === null) throw new Error(`Missing candidate blob: ${entry.path}`);
    expect(hashes[index], entry.path).toBe(candidateBlob);
    if (entry.classification === "exact") expect(candidateBlob, entry.path).toBe(entry.source.targetBlob);
    expect(entry.reason.length, entry.path).toBeGreaterThan(20);
  }
  const superseded = ledger.entries.filter(entry => entry.classification === "superseded");
  expect(superseded.map(entry => entry.path)).toEqual(["tests/retained-compaction.test.ts"]);
  expect(existsSync(resolve(root, superseded[0]!.path))).toBeFalse();

  const upstreamTests = ledger.entries.filter(entry =>
    /(?:^|\/)tests\/.*\.test\./.test(entry.path) || entry.path === "scripts/smoke-codex-interrupt.ts"
  );
  for (const entry of upstreamTests) expect(entry.assertions.length, entry.path).toBeGreaterThan(0);
  const sources = new Map<string, string>();
  for (const entry of ledger.entries) {
    for (const assertion of entry.assertions) {
      if (!sources.has(assertion.path)) sources.set(assertion.path, git(["show", `${publishedLedgerCommit}:${assertion.path}`]).replace(/\r\n/g, "\n"));
      const source = sources.get(assertion.path)!;
      expect(source, `${entry.path} -> ${assertion.path}`).toContain(assertion.contains);
    }
  }
});
