import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reconcileReleaseChecksums } from "../scripts/reconcile-release-checksums";

const digest = "a".repeat(64);
const local = `${digest}  app.zip\n`;
const asset = { name: "app.zip", digest: `sha256:${digest}` };

test("published checksums remain bound to the exact locally built asset set", () => {
  expect(reconcileReleaseChecksums(local, [asset, { name: "checksums.txt", digest: "sha256:old" }])).toBe(local);
  for (const assets of [[], [asset, asset], [{ ...asset, digest: null }],
    [{ ...asset, digest: `sha256:${"b".repeat(64)}` }], [asset, { ...asset, name: "stale.zip" }]]) {
    expect(() => reconcileReleaseChecksums(local, assets)).toThrow();
  }
  for (const manifest of ["", `${local}${local}`, `invalid  app.zip\n`, `${digest}  ../app.zip\n`]) {
    expect(() => reconcileReleaseChecksums(manifest, [asset])).toThrow();
  }
});

test("the release stays draft until published assets match the built manifest", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  const reconcile = workflow.indexOf("scripts/reconcile-release-checksums.ts");
  const publish = workflow.lastIndexOf("--draft=false");
  expect(workflow.indexOf("--draft=true")).toBeGreaterThan(-1);
  expect(reconcile).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(reconcile);
});
