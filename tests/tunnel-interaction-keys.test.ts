import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntimeKey, installRuntimeKeyBytes, managedRuntimeKeyPath } from "../src/tunnel";

test("Automatic and Zero Risk key imports preserve separate private files", () => {
  const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  const root = mkdtempSync(join(tmpdir(), "cgw-key-isolation-"));
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const automatic = installRuntimeKeyBytes("automatic-test-key");
    const manual = installRuntimeKeyBytes("manual-test-key", "manual");
    expect(automatic).toBe(managedRuntimeKeyPath("automatic"));
    expect(manual).toBe(managedRuntimeKeyPath("manual"));
    expect(automatic).not.toBe(manual);
    expect(readFileSync(automatic, "utf8")).toBe("automatic-test-key");
    expect(readFileSync(manual, "utf8")).toBe("manual-test-key");

    const source = join(root, "import.key");
    writeFileSync(source, "replacement-manual-test-key\n");
    expect(installRuntimeKey(source, "manual")).toBe(manual);
    expect(readFileSync(manual, "utf8")).toBe("replacement-manual-test-key\n");
    expect(readFileSync(automatic, "utf8")).toBe("automatic-test-key");
    writeFileSync(source, "replacement-automatic-test-key");
    expect(installRuntimeKey(source)).toBe(automatic);
    expect(readFileSync(automatic, "utf8")).toBe("replacement-automatic-test-key");
    expect(readFileSync(manual, "utf8")).toBe("replacement-manual-test-key\n");

    for (const mode of ["automatic", "manual"] as const) {
      expect(() => installRuntimeKeyBytes("", mode)).toThrow(/empty/);
      expect(() => installRuntimeKeyBytes(new Uint8Array(65_537), mode)).toThrow(/large/);
      if (process.platform !== "win32") expect(statSync(managedRuntimeKeyPath(mode)).mode & 0o077).toBe(0);
    }
    expect(readFileSync(automatic, "utf8")).toBe("replacement-automatic-test-key");
    expect(readFileSync(manual, "utf8")).toBe("replacement-manual-test-key\n");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
