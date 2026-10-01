import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(
  resolve(root, ".github/upstream-audit/v6.1.3.json"),
  "utf8",
)) as {
  baseline: string;
  semanticBaseline: string;
  upstream: string;
  automaticMergeTree: string;
  tag: { object: string; commit: string; signed: boolean };
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
    prior: {
      ledgerPath: string;
      ledgerBlob: string;
      ledgerDigestCanonicalization: string;
      ledgerSha256: string;
      evidencePath: string;
      evidenceSha256: string;
    };
  };
  pathGroups: Array<{ paths: string[] }>;
  changedTests: string[];
};

function git(args: string[], cwd = root): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

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

function evidenceDigest(path: string, content: Buffer): string {
  let bytes = content;
  if (path.endsWith(".json")) {
    let missingCarriageReturns = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === 0x0a && (index === 0 || content[index - 1] !== 0x0d)) {
        missingCarriageReturns += 1;
      }
    }
    if (missingCarriageReturns > 0) {
      bytes = Buffer.allocUnsafe(content.length + missingCarriageReturns);
      let output = 0;
      for (let index = 0; index < content.length; index += 1) {
        if (content[index] === 0x0a && (index === 0 || content[index - 1] !== 0x0d)) bytes[output++] = 0x0d;
        bytes[output++] = content[index]!;
      }
    }
  }
  return createHash("sha256").update(bytes).digest("hex");
}

test("v6.1.3 prior ledger digest is independent of checkout line endings", () => {
  const path = ".github/upstream-audit/v6.1.2.json";
  expect(evidenceDigest(path, Buffer.from("{\n  \"release\": \"v6.1.2\"\n}\n"))).toBe(
    evidenceDigest(path, Buffer.from("{\r\n  \"release\": \"v6.1.2\"\r\n}\r\n")),
  );
  expect(evidenceDigest(path, Buffer.from([0x80]))).not.toBe(
    evidenceDigest(path, Buffer.from([0x81])),
  );
});

test("v6.1.3 audit closes the exact linear upstream path, hunk, and test delta", () => {
  expect(ledger.baseline).toBe("dbc95c1a4210fa3ea44b8587fbd7a5cd193d0226");
  expect(ledger.semanticBaseline).toBe("2d73f626290a5062825bb595dabb89aaf88d16c5");
  expect(ledger.upstream).toBe("fa2d2c6c24926078b46eedb2186f69f2e8d548d7");
  expect(ledger.tag).toEqual({
    object: "2222375348e8b679099cc3869be6a329b36c908a",
    commit: ledger.upstream,
    signed: false,
  });
  expect(git(["rev-parse", `${ledger.upstream}^`])).toBe(ledger.semanticBaseline);
  expect(ledger.coverage).toEqual({
    paths: 30,
    hunks: 57,
    changedTests: 12,
    mappedPaths: 30,
    pending: 0,
    missing: 0,
  });

  const expectedPaths = git([
    "diff", "--name-only", `${ledger.semanticBaseline}..${ledger.upstream}`,
  ]).split(/\r?\n/).filter(Boolean).sort();
  const mappedPaths = ledger.pathGroups.flatMap(group => group.paths).sort();
  expect(mappedPaths).toEqual(expectedPaths);
  expect(new Set(mappedPaths).size).toBe(mappedPaths.length);
  expect(ledger.changedTests).toEqual(expectedPaths.filter(path =>
    /(^|\/)(tests?|__tests__)\/|\.test\./.test(path)
  ));
  const hunkCount = git([
    "diff", ledger.semanticBaseline, ledger.upstream,
  ]).split(/\r?\n/).filter(line => line.startsWith("@@")).length;
  expect(hunkCount).toBe(ledger.coverage.hunks);
});

test("v6.1.3 evidence is content-addressed, references v6.1.2, and reconstructs AUTO_MERGE", () => {
  const archive = readFileSync(resolve(root, ledger.evidence.path));
  expect(createHash("sha256").update(archive).digest("hex")).toBe(ledger.evidence.sha256);
  expect(ledger.evidence.prior.ledgerDigestCanonicalization).toBe("utf8-crlf");
  expect(git(["rev-parse", `${ledger.baseline}:${ledger.evidence.prior.ledgerPath}`]))
    .toBe(ledger.evidence.prior.ledgerBlob);
  const priorLedger = spawnSync("git", ["cat-file", "blob", ledger.evidence.prior.ledgerBlob], { cwd: root });
  expect(priorLedger.status).toBe(0);
  expect(evidenceDigest(ledger.evidence.prior.ledgerPath, priorLedger.stdout))
    .toBe(ledger.evidence.prior.ledgerSha256);
  const priorEvidence = readFileSync(resolve(root, ledger.evidence.prior.evidencePath));
  expect(createHash("sha256").update(priorEvidence).digest("hex"))
    .toBe(ledger.evidence.prior.evidenceSha256);

  const entries = tarEntries(archive);
  for (const required of [
    "manifest.json",
    "metadata.json",
    "prior-v6.1.2.json",
    "objects/auto-merge-objects.pack",
    "current/original-merge/auto-merge.txt",
    "current/original-merge/ls-files-unmerged.txt",
    "current/red/output.txt",
    "current/resolution-vs-B.patch",
    "current/upstream-range.diff",
  ]) expect(entries.has(required), required).toBeTrue();

  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
    autoMergeTrees: Record<string, string>;
    priorEvidence: {
      ledgerSha256: string;
      evidenceSha256: string;
    };
  };
  expect(manifest.autoMergeTrees).toEqual(ledger.evidence.autoMergeTrees);
  expect(manifest.priorEvidence.ledgerSha256).toBe(ledger.evidence.prior.ledgerSha256);
  expect(manifest.priorEvidence.evidenceSha256).toBe(ledger.evidence.prior.evidenceSha256);
  for (const item of manifest.files) {
    const content = entries.get(item.path);
    expect(content, item.path).toBeDefined();
    expect(content!.byteLength, item.path).toBe(item.bytes);
    expect(createHash("sha256").update(content!).digest("hex"), item.path).toBe(item.sha256);
  }

  const scratch = mkdtempSync(resolve(tmpdir(), "upstream-audit-v613-"));
  try {
    git(["init", "--bare", scratch]);
    const packPath = resolve(scratch, "objects/pack/auto-merge-objects.pack");
    mkdirSync(dirname(packPath), { recursive: true });
    writeFileSync(packPath, entries.get("objects/auto-merge-objects.pack")!);
    git(["--git-dir", scratch, "index-pack", packPath]);
    expect(git(["--git-dir", scratch, "cat-file", "-t", ledger.automaticMergeTree])).toBe("tree");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
