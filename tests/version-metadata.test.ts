import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { synchronizeVersionMetadata } from "../scripts/check-version";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("release metadata synchronizes derived launcher and installer versions", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-version-metadata-"));
  roots.push(root);
  mkdirSync(join(root, "launcher"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: "5.0.6-Enhanced.9" }, null, 2)}\n`);
  writeFileSync(join(root, "launcher", "package.json"), `${JSON.stringify({
    name: "launcher",
    version: "5.0.6-Enhanced.1",
    private: true,
  }, null, 2)}\n`);
  writeFileSync(join(root, "scripts", "install.sh"), [
    "#!/bin/sh",
    'VERSION="${CODEX_CHATGPT_WEB_VERSION:-5.0.6-Enhanced.1}"',
    "",
  ].join("\n"));

  expect(synchronizeVersionMetadata(root).sort()).toEqual([
    "launcher/package.json",
    "scripts/install.sh",
  ]);
  expect(JSON.parse(readFileSync(join(root, "launcher", "package.json"), "utf8")).version)
    .toBe("5.0.6-Enhanced.9");
  expect(readFileSync(join(root, "scripts", "install.sh"), "utf8"))
    .toContain('VERSION="${CODEX_CHATGPT_WEB_VERSION:-5.0.6-Enhanced.9}"');
  expect(synchronizeVersionMetadata(root)).toEqual([]);
});

test("runtime version reads the authoritative root package metadata", () => {
  const source = readFileSync(resolve(import.meta.dir, "..", "src", "version.ts"), "utf8");
  expect(source).toContain('from "../package.json"');
  expect(source).not.toMatch(/\d+\.\d+\.\d+-Enhanced\.\d+/);
});
