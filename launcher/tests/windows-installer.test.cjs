const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const powershell = process.env.POWERSHELL_EXE || (process.platform === "win32" ? "powershell.exe" : "pwsh");
const available = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });

test("Windows installer resolves only the official public release redirect", { skip: Boolean(available.error) }, () => {
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-File", path.join(__dirname, "windows-installer.test.ps1")], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /WINDOWS_INSTALLER_REDIRECT_OK/);
});
