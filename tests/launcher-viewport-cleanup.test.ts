import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

for (const mode of ["timeout", "interruption"]) {
  test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)(`viewport Electron exits when its test owner ends by ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "launcher-viewport-owner-"));
    const receipt = join(root, "receipt.json");
    const owner = Bun.spawn([process.execPath, "test", "launcher/tests/fixtures/viewport-owner.test.ts"], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, VIEWPORT_OWNER_TEST_ROOT: root, VIEWPORT_OWNER_TEST_RECEIPT: receipt,
        VIEWPORT_OWNER_TEST_TIMEOUT: String(mode === "timeout") },
    });
    const stdout = new Response(owner.stdout).text();
    const stderr = new Response(owner.stderr).text();
    let electronPid: number | undefined;
    try {
      const readyDeadline = Date.now() + 10_000;
      while (!existsSync(receipt) && Date.now() < readyDeadline) await Bun.sleep(50);
      expect(existsSync(receipt)).toBe(true);
      const ready = JSON.parse(readFileSync(receipt, "utf8"));
      electronPid = ready.electronPid;
      expect(ready.ownerPid).toBe(owner.pid);
      expect(alive(electronPid!)).toBe(true);
      if (mode === "interruption") owner.kill("SIGKILL");
      const exitCode = await owner.exited;
      expect(exitCode).not.toBe(0);
      const exitDeadline = Date.now() + 5_000;
      while (alive(electronPid!) && Date.now() < exitDeadline) await Bun.sleep(50);
      expect(alive(electronPid!)).toBe(false);
      if (mode === "timeout") expect(await stderr).toContain("this test timed out");
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
      if (electronPid && alive(electronPid)) {
        if (process.platform === "win32") {
          const killed = spawnSync("taskkill.exe", ["/PID", String(electronPid), "/T", "/F"], { windowsHide: true });
          if (killed.status !== 0) throw new Error(`Fixture cleanup failed: ${killed.stderr}`);
        }
        else process.kill(electronPid, "SIGKILL");
      }
      await Promise.all([stdout, stderr]);
      const cleanupDeadline = Date.now() + 5_000;
      for (;;) {
        try { rmSync(root, { recursive: true, force: true }); break; }
        catch (error) {
          if (!["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
            || Date.now() >= cleanupDeadline) throw error;
          await Bun.sleep(50);
        }
      }
    }
  }, 20_000);
}
