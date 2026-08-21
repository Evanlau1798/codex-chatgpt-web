import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");
const ROOT_TEST_BATCH_SIZE = 30;
const rootTestFiles = readdirSync(join(root, "tests"), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map(entry => `tests/${entry.name}`)
  .sort();
if (rootTestFiles.length === 0) throw new Error("Repository verification found no root test files");

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "typecheck"]);
  for (let start = 0; start < rootTestFiles.length; start += ROOT_TEST_BATCH_SIZE) {
    await run(["test", ...rootTestFiles.slice(start, start + ROOT_TEST_BATCH_SIZE)]);
  }
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
