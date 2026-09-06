import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("setup rejects Bigger Context while the default Enhanced mode is active", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-web-gpt-context-mode-"));
  try {
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      "--home", home,
      "setup", "--browser-only", "--bigger-context", "--acknowledge-unofficial",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Bigger Context is unavailable while Enhanced Web session mode is enabled",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup rejects contradictory automatic compaction flags", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-web-gpt-compaction-mode-"));
  try {
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      "--home", home,
      "setup", "--browser-only", "--no-auto-compact", "--auto-compact", "--acknowledge-unofficial",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Choose at most one compaction mode: --no-auto-compact or --auto-compact",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
