import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

export function listRootTestFiles(testsDirectory = join(projectRoot, "tests")): string[] {
  return readdirSync(testsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map(entry => join(testsDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function runFile(file: string): Promise<void> {
  const displayPath = relative(projectRoot, file);
  process.stdout.write(`\n[root-tests] ${displayPath}\n`);
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
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Root test file failed (${exitCode}): ${displayPath}`);
}

if (import.meta.main) {
  const files = listRootTestFiles();
  if (files.length === 0) throw new Error("No root TypeScript test files were found");
  for (const file of files) await runFile(file);
  process.stdout.write(`\n[root-tests] ${files.length} files passed in isolated Bun processes\n`);
}
