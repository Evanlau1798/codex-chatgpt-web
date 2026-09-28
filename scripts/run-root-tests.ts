import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const MAX_BUN_CRASH_RETRIES = 2;
const ROOT_TEST_BATCH_SIZE = 24;

export function listRootTestFiles(testsDirectory = join(projectRoot, "tests")): string[] {
  return readdirSync(testsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map(entry => join(testsDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function shouldRetryBunCrash(exitCode: number, attempt: number): boolean {
  return exitCode === 3 && attempt <= MAX_BUN_CRASH_RETRIES;
}

export function rootTestBatches<T>(items: T[], batchSize = ROOT_TEST_BATCH_SIZE): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Root test batch size must be positive");
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}

export function rootTestEnvironment(
  platform = process.platform,
  environment: Record<string, string | undefined> = process.env,
  testHome?: string,
): Record<string, string | undefined> {
  const isolatedHome = testHome ?? mkdtempSync(join(tmpdir(), "codex-chatgpt-web-root-test-"));
  const isolated = { ...environment, CODEX_CHATGPT_WEB_HOME: isolatedHome };
  return platform === "darwin" ? { ...isolated, TMPDIR: "/tmp" } : isolated;
}

async function runFile(file: string): Promise<void> {
  const displayPath = relative(projectRoot, file);
  for (let attempt = 1; ; attempt += 1) {
    process.stdout.write(`\n[root-tests] ${displayPath}${attempt > 1 ? ` (runtime retry ${attempt - 1})` : ""}\n`);
    const testHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-root-test-"));
    let exitCode: number;
    try {
      const child = Bun.spawn([
        process.execPath,
        "test",
        "--no-orphans",
        "--path-ignore-patterns=tmp",
        displayPath,
      ], {
        cwd: projectRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: rootTestEnvironment(process.platform, process.env, testHome),
      });
      exitCode = await child.exited;
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
    if (exitCode === 0) return;
    if (!shouldRetryBunCrash(exitCode, attempt)) {
      throw new Error(`Root test file failed (${exitCode}): ${displayPath}`);
    }
    process.stderr.write(`[root-tests] Bun crashed while running ${displayPath}; retrying in a fresh process\n`);
  }
}

async function runWorkerBatch(start: number, count: number, statusPath: string): Promise<void> {
  try {
    const files = listRootTestFiles().slice(start, start + count);
    if (files.length === 0) throw new Error(`Root test worker received an empty batch at ${start}`);
    for (const file of files) await runFile(file);
    writeFileSync(statusPath, "passed", "utf8");
  } catch (error) {
    writeFileSync(statusPath, "test-failed", "utf8");
    throw error;
  }
}

async function runBatch(start: number, count: number): Promise<void> {
  const statusRoot = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-root-batch-"));
  const statusPath = join(statusRoot, "status.txt");
  let exitCode: number;
  let status = "";
  try {
    const child = Bun.spawn([
      process.execPath,
      import.meta.path,
      "--worker-start",
      String(start),
      "--worker-count",
      String(count),
      "--worker-status",
      statusPath,
    ], {
      cwd: projectRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    exitCode = await child.exited;
    if (existsSync(statusPath)) status = readFileSync(statusPath, "utf8").trim();
  } finally {
    rmSync(statusRoot, { recursive: true, force: true });
  }
  if (exitCode === 0 && status === "passed") return;
  throw new Error(`Root test batch failed (${exitCode}, status=${status || "missing"}): ${start}-${start + count - 1}`);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const workerStart = argumentValue("--worker-start");
  const workerCount = argumentValue("--worker-count");
  const workerStatus = argumentValue("--worker-status");
  if (workerStart !== undefined || workerCount !== undefined || workerStatus !== undefined) {
    if (workerStart === undefined || workerCount === undefined || workerStatus === undefined) {
      throw new Error("Root test worker arguments are incomplete");
    }
    await runWorkerBatch(Number(workerStart), Number(workerCount), workerStatus);
  } else {
    const files = listRootTestFiles();
    if (files.length === 0) throw new Error("No root TypeScript test files were found");
    let start = 0;
    for (const batch of rootTestBatches(files)) {
      await runBatch(start, batch.length);
      start += batch.length;
    }
    process.stdout.write(`\n[root-tests] ${files.length} files passed in isolated Bun processes\n`);
  }
}
