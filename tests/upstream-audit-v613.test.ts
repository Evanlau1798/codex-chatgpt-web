import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import ts from "typescript";

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

test.each(["v6.1.4", "v6.1.5", "v6.1.7"])("continuing %s evidence closes source anchors and reconstructs the original merge from retained prerequisites", release => {
  const next = JSON.parse(readFileSync(resolve(root, `.github/upstream-audit/${release}.json`), "utf8"));
  if (release === "v6.1.5") {
    expect(next.coverage).toEqual({paths: 54, hunks: 202, testPaths: 21, testCaseDeltas: 61, pending: 0, missing: 0});
    expect(next.upstream).toBe("92a356fac2292e3af5a97ab7ba634edd8d38621e");
    expect(next.tag.object).toBe("38311dfe5c8914b397b6f890e2b21c990dd4a84c");
  }
  if (release === "v6.1.7") {
    expect(next.coverage).toEqual({paths: 75, hunks: 377, testPaths: 31, testCaseDeltas: 127, pending: 0, missing: 0});
    expect(next.upstream).toBe("f9ad4ae83a579287105ad822dd0c3e0029b04ef6");
    expect(next.tag.object).toBe("bd6a3021d911cfd6e7dbe2b45b117b5cb365c5c7");
  }
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const publishedObjects = release === "v6.1.7"
    ? new Set(git(["rev-list", "--objects", "HEAD"]).split(/\r?\n/).map(line => line.split(" ")[0])) : undefined;
  const retainedTargets = new Map<string, Buffer>();
  if (next.evidence.targetBlobs) {
    const retained = next.evidence.targetBlobs;
    expect(retained.path).toBe(`.github/upstream-audit/evidence/${retained.sha256}.tar.gz`);
    const bytes = readFileSync(resolve(root, retained.path));
    expect(digest(bytes)).toBe(retained.sha256);
    expect(bytes.length).toBe(retained.bytes);
    for (const [oid, data] of tarEntries(bytes)) {
      expect(oid).toMatch(/^[a-f0-9]{40}$/);
      expect(createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")).toBe(oid);
      retainedTargets.set(oid, data);
    }
    expect([...retainedTargets.keys()].sort()).toEqual([...retained.objects].sort());
  }
  const blob = (oid: string) => {
    const retained = retainedTargets.get(oid);
    if (retained) return retained;
    const result = spawnSync("git", ["cat-file", "blob", oid], { cwd: root });
    expect(result.status, result.stderr.toString("utf8")).toBe(0);
    return result.stdout;
  };
  const textDigest = (text: string) => digest(Buffer.from(text.replaceAll("\r\n", "\n")));
  expect(next.tag.signed).toBeFalse();
  expect(git(["merge-base", next.semanticBaseline, next.upstream])).toBe(next.semanticBaseline);
  expect(git(["rev-list", "--count", `${next.semanticBaseline}..${next.upstream}`])).toBe(release === "v6.1.7" ? "4" : "1");
  const expectedPaths = git(["diff", "--name-only", next.semanticBaseline, next.upstream]).split(/\r?\n/).sort();
  expect(next.paths.map((item: any) => item.path).sort()).toEqual(expectedPaths);
  expect(new Set(next.paths.map((item: any) => item.path)).size).toBe(expectedPaths.length);
  const expectedHunks = expectedPaths.flatMap(path => {
    const patch = spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", next.semanticBaseline, next.upstream, "--", path], {cwd: root, encoding: "utf8"});
    expect(patch.status).toBe(0);
    return patch.stdout.split(/(?=^@@ )/m).slice(1).map((chunk, index) => ({path, index: index + 1, sha256: textDigest(chunk)}));
  });
  expect(next.hunks.map(({path, index, sha256}: any) => ({path, index, sha256}))).toEqual(expectedHunks);
  for (const item of [...next.paths, ...next.hunks, ...next.tests]) {
    expect(["exact", "adapted", "superseded"], item.id).toContain(item.classification);
    expect(next.obligations.some((entry: any) => entry.id === item.obligation), item.id).toBeTrue();
  }
  expect(new Set(next.tests.map((item: any) => item.id)).size).toBe(next.tests.length);
  const declaredCases = (text: string, path: string) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const found: Array<{name: string; sha256: string}> = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && (release !== "v6.1.4" ? /^(test|it|domTest)(\.|\(|$)/ : /^(test|it)(\.|\(|$)/).test(node.expression.getText(source))
        && node.arguments.length >= 2 && (ts.isArrowFunction(node.arguments[1]!) || ts.isFunctionExpression(node.arguments[1]!))) {
        const name = node.arguments[0]!;
        if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
          found.push({name: name.text, sha256: textDigest(node.getText(source))});
        } else if (ts.isTemplateExpression(name) || ts.isBinaryExpression(name)) {
          found.push({name: name.getText(source), sha256: textDigest(node.getText(source))});
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return found;
  };
  const expectedCases = expectedPaths.filter(path => /(^|\/)(tests?|__tests__)\/|\.test\./.test(path)).flatMap(path => {
    const previous = spawnSync("git", ["show", `${next.semanticBaseline}:${path}`], {cwd: root, encoding: "utf8"});
    const before = previous.status === 0 ? declaredCases(previous.stdout, path) : [];
    const after = declaredCases(blob(git(["rev-parse", `${next.upstream}:${path}`])).toString("utf8"), path);
    return [
      ...after.filter(item => !before.some(old => old.name === item.name && old.sha256 === item.sha256))
        .map(item => ({path, name: item.name, sha256: item.sha256, status: before.some(old => old.name === item.name) ? "modified" : "added"})),
      ...before.filter(item => !after.some(current => current.name === item.name)).map(item => ({path, ...item, status: "removed"})),
    ];
  });
  expect(next.tests.map((item: any) => ({path: item.source.path, name: item.source.name, sha256: item.source.sha256, status: item.status}))).toEqual(expectedCases);
  for (const item of next.tests) {
    expect(git(["rev-parse", `${item.status === "removed" ? next.semanticBaseline : next.upstream}:${item.source.path}`])).toBe(item.source.blob);
    const source = blob(item.source.blob).toString("utf8").replaceAll("\r\n", "\n");
    expect(textDigest(source.split("\n").slice(item.source.start - 1, item.source.end).join("\n")), item.id).toBe(item.source.lineSha256);
    expect(item.targets.length, item.id).toBeGreaterThan(0);
    for (const target of item.targets) {
      if (publishedObjects) expect(publishedObjects.has(target.blob) || retainedTargets.has(target.blob), target.path).toBeTrue();
      const text = blob(target.blob).toString("utf8").replaceAll("\r\n", "\n");
      expect(textDigest(text.split("\n").slice(target.start - 1, target.end).join("\n")), target.path).toBe(target.lineSha256);
      if (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version.startsWith(`${release.slice(1)}-`)) {
        // Historical source anchors stay immutable; follow-ups attest exact bytes.
        const followups: Array<{path: string; baselineSha256: string; currentSha256: string; reason: string}> =
          JSON.parse(readFileSync(resolve(root, `.github/upstream-audit/${release}-followups.json`), "utf8"));
        const matching = followups.filter(entry => entry.path === target.path);
        expect(matching.length, target.path).toBeLessThanOrEqual(1);
        const followup = matching[0];
        if (followup) {
          expect(followup.baselineSha256, target.path).toBe(textDigest(text));
          expect(followup.reason.length, target.path).toBeGreaterThan(20);
          expect(followup.currentSha256, target.path).not.toBe(followup.baselineSha256);
        }
        expect(textDigest(readFileSync(resolve(root, target.path), "utf8")), target.path)
          .toBe(followup?.currentSha256 ?? textDigest(text));
      }
    }
  }
  expect(next.tests.length).toBe(next.coverage.testCaseDeltas);
  expect(next.evidence.prior.ledgerDigestCanonicalization).toBe("git-blob-exact-bytes");
  expect(git(["rev-parse", `${next.baseline}:${next.evidence.prior.ledgerPath}`])).toBe(next.evidence.prior.ledgerBlob);
  expect(digest(blob(next.evidence.prior.ledgerBlob))).toBe(next.evidence.prior.ledgerSha256);
  const archive = readFileSync(resolve(root, next.evidence.path));
  expect(digest(archive)).toBe(next.evidence.sha256);
  expect(archive.length).toBe(next.evidence.bytes);
  const entries = tarEntries(archive);
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
  expect(manifest.prerequisites).toEqual([next.baseline, next.upstream]);
  for (const item of manifest.files) {
    const content = entries.get(item.path)!;
    expect(content?.length, item.path).toBe(item.bytes);
    expect(digest(content), item.path).toBe(item.sha256);
  }
  const scratch = mkdtempSync(resolve(tmpdir(), "upstream-audit-continuing-"));
  try {
    git(["init", "--bare", scratch]);
    git(["--git-dir", scratch, "fetch", "--no-tags", root, next.baseline, next.upstream]);
    const packPath = resolve(scratch, "objects/pack/auto-merge-objects.pack");
    writeFileSync(packPath, entries.get("objects/auto-merge-objects.pack")!);
    git(["--git-dir", scratch, "index-pack", packPath]);
    expect(git(["--git-dir", scratch, "cat-file", "-t", next.automaticMergeTree])).toBe("tree");
    expect(git(["--git-dir", scratch, "rev-parse", `${next.tag.object}^{commit}`])).toBe(next.upstream);
    expect(git(["--git-dir", scratch, "rev-parse", `${next.semanticTag.object}^{commit}`])).toBe(next.semanticBaseline);
    const trees = git(["--git-dir", scratch, "rev-list", "--objects", next.automaticMergeTree]).split(/\r?\n/);
    const check = spawnSync("git", ["--git-dir", scratch, "cat-file", "--batch-check"], {
      input: trees.map(line => line.split(" ")[0]).join("\n") + "\n", encoding: "utf8",
    });
    expect(check.status).toBe(0);
    expect(check.stdout).not.toContain("missing");
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}, 120_000);
