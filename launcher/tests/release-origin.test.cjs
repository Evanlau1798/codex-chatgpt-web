const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../..");
const releaseRepository = "Evanlau1798/codex-chatgpt-web";

test("Enhanced release installers and launcher updates use the fork release origin", () => {
  const installShell = fs.readFileSync(path.join(repositoryRoot, "scripts/install.sh"), "utf8");
  const launcherShell = fs.readFileSync(path.join(repositoryRoot, "scripts/install-launcher.sh"), "utf8");
  const launcherPowerShell = fs.readFileSync(path.join(repositoryRoot, "scripts/install-launcher.ps1"), "utf8");
  const launcherUpdater = fs.readFileSync(path.join(repositoryRoot, "launcher/electron/update.cjs"), "utf8");

  assert.match(installShell, new RegExp(`CODEX_CHATGPT_WEB_REPOSITORY:-${releaseRepository}`));
  assert.match(launcherShell, new RegExp(`CODEX_WEB_GPT_REPOSITORY:-${releaseRepository}`));
  assert.match(launcherPowerShell, new RegExp(`else \\{ "${releaseRepository}" \\}`));
  assert.match(launcherUpdater, new RegExp(`REPOSITORY = "${releaseRepository}"`));
});

test("Enhanced release readmes install and clone from the fork", () => {
  for (const name of ["README.md", "README.zh-CN.md", "README.ja.md"]) {
    const readme = fs.readFileSync(path.join(repositoryRoot, name), "utf8");
    assert.match(readme, new RegExp(`github\\.com/${releaseRepository}/releases/latest/download/install-launcher`));
    assert.match(readme, new RegExp(`git clone https://github\\.com/${releaseRepository}\\.git`));
    assert.match(readme, /3\.0\.1-Enhanced\.1/);
  }
});
