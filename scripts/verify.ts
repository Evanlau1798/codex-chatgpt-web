import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export async function run(args: string[], verbose = false): Promise<void> {
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

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
  const runtimeBundle = join(scratch, "runtime");
  const liveWeb = process.argv.includes("--live-web");
  const verbose = process.argv.includes("--verbose");
  const verify = (args: string[]) => run(args, verbose);
  try {
    await verify(["run", "check-version"]);
    await verify(["run", "audit"]);
    await verify(["run", "launcher:audit"]);
    await verify(["run", "typecheck"]);
    await verify(["run", "test"]);
    await verify(["run", "launcher:typecheck"]);
    await verify(["run", "launcher:test"]);
    await verify(["run", "launcher:build"]);
    await verify(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
    await verify([
      "run",
      "scripts/generate-third-party-notices.ts",
      join(scratch, "THIRD_PARTY_NOTICES.txt"),
      "--include-launcher",
    ]);
    await verify(["run", "scripts/smoke-release.ts", runtimeBundle]);
    if (liveWeb) await verify(["run", "scripts/smoke-candidate-web.ts", runtimeBundle]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
