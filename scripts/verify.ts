import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listRootTestFiles, rootTestBatches } from "./run-root-tests";
import { ensurePinnedLifecycleClients } from "./lifecycle-sim/entry";
import { runLifecycleSimulation } from "./lifecycle-sim/run";

const root = resolve(import.meta.dir, "..");
let verbose = false;
const OUTPUT_CHUNK_SIZE = 16_384;

export function writeBufferedOutput(
  output: string,
  write: (chunk: string) => unknown,
  chunkSize = OUTPUT_CHUNK_SIZE,
): void {
  for (let offset = 0; offset < output.length;) {
    let end = Math.min(output.length, offset + chunkSize);
    if (end < output.length
      && output.charCodeAt(end - 1) >= 0xD800 && output.charCodeAt(end - 1) <= 0xDBFF
      && output.charCodeAt(end) >= 0xDC00 && output.charCodeAt(end) <= 0xDFFF) {
      end = end - offset === 1 ? end + 1 : end - 1;
    }
    write(output.slice(offset, end));
    offset = end;
  }
}

export function rootTestBatchCommands(files: string[], batchSize?: number): string[][] {
  let start = 0;
  return rootTestBatches(files, batchSize).map(batch => {
    const command = [
      "run",
      "scripts/run-root-tests.ts",
      "--worker-start",
      String(start),
      "--worker-count",
      String(batch.length),
    ];
    start += batch.length;
    return command;
  });
}

export async function run(args: string[], showOutput = verbose, cwd = root): Promise<void> {
  const label = `bun ${args.join(" ")}`;
  console.log(`[verify] ${label}`);
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdin: "inherit",
    stdout: showOutput ? "inherit" : "pipe",
    stderr: showOutput ? "inherit" : "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    showOutput ? Promise.resolve("") : new Response(child.stdout).text(),
    showOutput ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  if (showOutput || exitCode !== 0) {
    if (stderr) writeBufferedOutput(stderr, chunk => process.stderr.write(chunk));
    if (stdout) writeBufferedOutput(stdout, chunk => process.stdout.write(chunk));
  }
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): ${label}`);
}

async function runRootTests(): Promise<ReadonlySet<string>> {
  const files = listRootTestFiles();
  if (files.length === 0) throw new Error("No root TypeScript test files were found");
  for (const command of rootTestBatchCommands(files)) await run(command);
  return new Set(files);
}

export async function verifyBuild(runtimeBundle: string, liveWeb: boolean, packageApp = false, execute = run): Promise<void> {
  // The same wrapper has already passed launcher:typecheck.
  await execute(["run", "--cwd", "launcher", "build:renderer"]);
  await execute(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await execute(["run", "scripts/smoke-release.ts", runtimeBundle]);
  if (liveWeb) await execute(["run", "scripts/smoke-candidate-web.ts", runtimeBundle]);
  if (packageApp) await execute(["run", "scripts/package.cjs", `--runtime=${runtimeBundle}`], verbose, join(root, "launcher"));
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
  const runtimeBundle = join(scratch, "runtime");
  const liveWeb = process.argv.includes("--live-web");
  verbose = process.argv.includes("--verbose");
  try {
    await run(["run", "check-version"]);
    await run(["run", "audit"]);
    await run(["run", "launcher:audit"]);
    await run(["run", "typecheck"]);
    const passedRootTests = await runRootTests();
    await run(["run", "launcher:typecheck"]);
    await run(["run", "launcher:test"]);
    if (liveWeb) {
      // In-memory evidence from this wrapper only; standalone lifecycle remains complete.
      const clients = await ensurePinnedLifecycleClients();
      await runLifecycleSimulation("all", name => clients[name],
        (args, cwd) => run(args.slice(1), verbose, cwd), passedRootTests);
    }
    await verifyBuild(runtimeBundle, liveWeb, process.argv.includes("--package"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
