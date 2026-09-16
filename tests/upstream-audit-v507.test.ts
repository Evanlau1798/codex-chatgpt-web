import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(resolve(root, ".github/upstream-audit/v5.0.7.json"), "utf8")) as {
  baseline: string;
  semanticBaseline: string;
  upstream: string;
  automaticMergeTree: string;
  evidence: { path: string; sha256: string };
  resolutions: Array<{ classification: string }>;
};

test("v5.0.7 upstream audit pins recoverable merge evidence", () => {
  expect(ledger.baseline).toBe("1ebf7f5d23bf785539337f4a0310b85dbeeb551e");
  expect(ledger.semanticBaseline).toBe("e85e3693fdb4e3e033348c08df0298c20fcdb612");
  expect(ledger.upstream).toBe("2f5f0b9e6526415973ff104840c3b78e972792f9");
  expect(ledger.automaticMergeTree).toMatch(/^[a-f0-9]{40}$/);
  expect(new Set(ledger.resolutions.map(entry => entry.classification)))
    .toEqual(new Set(["adapted", "integrated", "not-applicable"]));
  const evidence = readFileSync(resolve(root, ledger.evidence.path));
  expect(createHash("sha256").update(evidence).digest("hex")).toBe(ledger.evidence.sha256);
});
