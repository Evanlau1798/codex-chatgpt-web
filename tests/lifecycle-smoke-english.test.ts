import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("lifecycle smoke scripts contain no CJK prompt or validation text", () => {
  const root = join(import.meta.dir, "..", "scripts", "lifecycle-smoke");
  const offenders = readdirSync(root)
    .filter(name => name.endsWith(".ts"))
    .filter(name => /[\u3400-\u9fff]/u.test(readFileSync(join(root, name), "utf8")));

  expect(offenders).toEqual([]);
});

test("Claude TTL resume names and verifies the existing child identity", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("agent ID ${childId}");
  expect(source).toContain("resumedChildId === childId");
});
