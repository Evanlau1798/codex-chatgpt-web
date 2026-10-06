import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listRootTestFiles, rootTestBatches } from "./run-root-tests";

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

export async function run(args: string[], showOutput = verbose): Promise<void> {
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
  if (showOutput || exitCode !== 0) {
    if (stderr) writeBufferedOutput(stderr, chunk => process.stderr.write(chunk));
    if (stdout) writeBufferedOutput(stdout, chunk => process.stdout.write(chunk));
  }
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): ${label}`);
}

async function runRootTests(): Promise<void> {
  const files = listRootTestFiles();
  if (files.length === 0) throw new Error("No root TypeScript test files were found");
  for (const command of rootTestBatchCommands(files)) await run(command);
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
    await runRootTests();
    await run(["run", "launcher:typecheck"]);
    await run(["run", "launcher:test"]);
    if (liveWeb) await run(["run", "lifecycle:sim", "--lane=all"]);
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
}

if (import.meta.main) await main();
