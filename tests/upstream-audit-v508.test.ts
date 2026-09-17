import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(resolve(root, ".github/upstream-audit/v5.0.8.json"), "utf8")) as {
  baseline: string;
  semanticBaseline: string;
  upstream: string;
  automaticMergeTree: string;
  evidence: { path: string; sha256: string };
  resolutions: Array<{ classification: string }>;
};

function tarEntry(archive: Buffer, expected: string): string {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const rawSize = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(rawSize || "0", 8);
    const start = offset + 512;
    if (name === expected) return tar.subarray(start, start + size).toString("utf8");
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Missing audit evidence entry: ${expected}`);
}

test("v5.0.8 upstream audit pins recoverable merge evidence", () => {
  expect(ledger.baseline).toBe("1d875d7150190eff74241fae49ec5312b20bf5c6");
  expect(ledger.semanticBaseline).toBe("2f5f0b9e6526415973ff104840c3b78e972792f9");
  expect(ledger.upstream).toBe("e0904bc82001f06e06e7f85f564ce760c92bfd79");
  expect(ledger.automaticMergeTree).toMatch(/^[a-f0-9]{40}$/);
  expect(new Set(ledger.resolutions.map(entry => entry.classification)))
    .toEqual(new Set(["adapted", "integrated", "not-applicable"]));
  const evidence = readFileSync(resolve(root, ledger.evidence.path));
  expect(createHash("sha256").update(evidence).digest("hex")).toBe(ledger.evidence.sha256);
  expect(tarEntry(evidence, "./orig-head.txt").trim()).toBe(ledger.baseline);
  expect(tarEntry(evidence, "./merge-head.txt").trim()).toBe(ledger.upstream);
  const stagedPatch = tarEntry(evidence, "./staged.patch");
  const prematureNextGeneration = `Codex Native${3}`;
  expect(stagedPatch).not.toContain(prematureNextGeneration);
  expect(readFileSync(resolve(root, "src/config-interaction.ts"), "utf8")).toContain('"Codex Native2"');
  expect(readFileSync(resolve(root, "launcher/electron/connector-identity.cjs"), "utf8"))
    .toContain('"Codex Native2"');
});
