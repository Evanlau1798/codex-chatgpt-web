import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeBufferedOutput } from "../scripts/verify";

const repo = resolve(import.meta.dir, "..");
const verifyModule = pathToFileURL(resolve(repo, "scripts", "verify.ts")).href;
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function invoke(args: string[], verbose = false) {
  const source = `import { run } from ${JSON.stringify(verifyModule)}; await run(${JSON.stringify(args)}, ${verbose});`;
  const result = Bun.spawnSync([process.execPath, "-e", source], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

test("release verification hides successful output unless verbose", () => {
  const code = [
    `process.stdout.write(Buffer.from("c3VjY2Vzcy1vdXQ=", "base64"))`,
    `process.stderr.write(Buffer.from("c3VjY2Vzcy1lcnI=", "base64"))`,
  ].join(";");

  const concise = invoke(["-e", code]);
  expect(concise.status).toBe(0);
  expect(concise.stdout).toContain("[verify] bun -e");
  expect(concise.stdout).not.toContain("success-out");
  expect(concise.stderr).not.toContain("success-err");

  const detailed = invoke(["-e", code], true);
  expect(detailed.status).toBe(0);
  expect(detailed.stdout).toContain("success-out");
  expect(detailed.stderr).toContain("success-err");
});

test("release verification replays failed output in concise mode", () => {
  const code = [
    `process.stdout.write(Buffer.from("ZmFpbHVyZS1vdXQ=", "base64"))`,
    `process.stderr.write(Buffer.from("ZmFpbHVyZS1lcnI=", "base64"))`,
    "process.exit(7)",
  ].join(";");
  const failed = invoke(["-e", code]);

  expect(failed.status).not.toBe(0);
  expect(failed.stdout).toContain("failure-out");
  expect(failed.stderr).toContain("failure-err");
  expect(failed.stderr).toContain("Verification command failed (7)");
});

test("release verification splits buffered output into runner-safe writes", () => {
  const writes: string[] = [];
  const output = `${"x".repeat(16_383)}😀${"x".repeat(23_615)}`;

  writeBufferedOutput(output, chunk => writes.push(chunk), 16_384);

  expect(writes.length).toBe(3);
  expect(Math.max(...writes.map(chunk => chunk.length))).toBe(16_384);
  expect(writes.some(chunk => /[\uD800-\uDBFF]$/.test(chunk))).toBeFalse();
  expect(writes.some(chunk => /^[\uDC00-\uDFFF]/.test(chunk))).toBeFalse();
  expect(writes.join("")).toBe(output);
});
