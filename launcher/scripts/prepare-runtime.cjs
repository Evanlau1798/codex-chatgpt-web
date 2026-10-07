const { spawnSync } = require("node:child_process");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const output = path.join(launcherRoot, "build", "runtime");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;

const result = spawnSync(bun, ["run", "scripts/build-runtime-bundle.ts", output], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
