import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  findClaudeTranscript,
  joinSmokePath,
  resolveLifecycleExecutable,
} from "../scripts/lifecycle-smoke/paths";

test("smoke prompt paths follow the target platform instead of hardcoded separators", () => {
  expect(joinSmokePath(posix, "/work/renamed-checkout", "tests")).toBe(
    "/work/renamed-checkout/tests",
  );
  expect(joinSmokePath(win32, "D:\\work\\renamed-checkout", "tests", "sample.test.ts")).toBe(
    "D:\\work\\renamed-checkout\\tests\\sample.test.ts",
  );
});

test("Windows lifecycle commands prefer native executables over command shims", () => {
  const found: Record<string, string> = {
    "codex.exe": "C:\\native\\codex.exe",
    codex: "C:\\npm\\codex.cmd",
  };
  expect(resolveLifecycleExecutable("codex", "win32", name => found[name] ?? null))
    .toBe("C:\\native\\codex.exe");
});

test("Codex process probes use Bun's native spawn path consistently", () => {
  for (const name of ["smoke-codex-cancel.ts", "smoke-codex-interrupt.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", "scripts", name), "utf8");
    expect(source).toContain("Bun.spawnSync");
    expect(source).not.toContain('from "node:child_process"');
  }
});

test("the interrupt probe exercises the production-shaped bundled CLI hook", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "smoke-codex-interrupt.ts"), "utf8");
  expect(source).toContain("await Bun.build");
  expect(source).toContain("config.runtimeCommand = [resolve(process.execPath), cliBundle]");
});

test("Codex lifecycle prompts use the portable smoke path helper", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "codex-lane.ts"), "utf8");
  expect(source).not.toContain("${repo}\\\\tests");
  expect(source).toContain("smokePath(repoTests");
});

test("Claude transcript discovery is independent of drive and checkout encoding", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-smoke-paths-"));
  try {
    const transcript = join(root, "projects", "arbitrary-encoded-checkout", "session-1.jsonl");
    mkdirSync(join(root, "projects", "arbitrary-encoded-checkout"), { recursive: true });
    writeFileSync(transcript, "");
    expect(findClaudeTranscript(root, "session-1")).toBe(transcript);
    expect(() => findClaudeTranscript(root, "missing")).toThrow("Claude transcript was not found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
