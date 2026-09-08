import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");
const liveWeb = process.argv.includes("--live-web");
const verbose = process.argv.includes("--verbose");

async function run(args: string[]): Promise<void> {
  const label = `bun ${args.join(" ")}`;
  console.log(`[verify] ${label}`);
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (verbose || exitCode !== 0) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): ${label}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "typecheck"]);
  await run(["run", "test"]);
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
  if (liveWeb) await run(["run", "scripts/smoke-candidate-web.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
