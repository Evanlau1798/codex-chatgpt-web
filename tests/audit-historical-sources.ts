import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

export function historicalSources(commit: string, paths: string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repositoryRoot, input: unique.map(path => `${commit}:${path}`).join("\n") + "\n",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status, result.error?.message ?? result.stderr.toString()).toBe(0);
  const sources = new Map<string, string>();
  let offset = 0;
  for (const path of unique) {
    const lineEnd = result.stdout.indexOf(10, offset);
    expect(lineEnd).toBeGreaterThanOrEqual(offset);
    const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(result.stdout.subarray(offset, lineEnd).toString("ascii"));
    expect(header, path).not.toBeNull();
    const end = lineEnd + 1 + Number(header![2]);
    expect(end).toBeLessThan(result.stdout.length);
    expect(result.stdout[end]).toBe(10);
    sources.set(path, result.stdout.subarray(lineEnd + 1, end).toString("utf8").replace(/\r\n/g, "\n"));
    offset = end + 1;
  }
  expect(offset).toBe(result.stdout.length);
  return sources;
}
