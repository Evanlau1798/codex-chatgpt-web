import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runLifecycleSimulation } from "../scripts/lifecycle-sim/run";
import { claudeLifecycleTests, codexLifecycleTests, sharedLifecycleTests } from "../scripts/lifecycle-sim/manifest";
import { verifyBuild } from "../scripts/verify";

const root = resolve(import.meta.dir, "..");
const manifest = [...codexLifecycleTests, ...claudeLifecycleTests, ...sharedLifecycleTests];
const executable = (name: string) => `pinned-${name}`;

test("standalone lifecycle runs every manifest assertion and all seven real client probes", async () => {
  const commands: string[][] = [];
  await runLifecycleSimulation("all", executable, async args => { commands.push(args); });
  expect(commands.filter(args => args[1] === "test").flatMap(args => args.slice(2)).sort())
    .toEqual(manifest.map(file => file.slice(6)).sort());
  expect(commands.filter(args => args[1] === "run")).toHaveLength(7);
});

test("same-wrapper passed root assertions are reused without removing real client probes or unverified files", async () => {
  const commands: string[][] = [];
  const passed = new Set(manifest.slice(1).map(file => resolve(root, file)));
  await runLifecycleSimulation("all", executable, async args => { commands.push(args); }, passed);
  expect(commands.filter(args => args[1] === "test").flatMap(args => args.slice(2)))
    .toEqual([codexLifecycleTests[0].slice(6)]);
  expect(commands.filter(args => args[1] === "run")).toHaveLength(7);
});

test("failed client probe stops lifecycle acceptance even with complete root evidence", async () => {
  const calls: string[][] = [];
  await expect(runLifecycleSimulation("all", executable, async args => {
    calls.push(args);
    throw new Error("client probe failed");
  }, new Set(manifest.map(file => resolve(root, file))))).rejects.toThrow("client probe failed");
  expect(calls).toHaveLength(1);
});

test("verified build packages its validated artifact without repeating typecheck, runtime build or notices", async () => {
  const commands: string[][] = [];
  await verifyBuild("validated-runtime", false, true, async args => { commands.push(args); });
  expect(commands.map(args => args.slice(0, 2))).toEqual([
    ["run", "--cwd"], ["run", "scripts/build-runtime-bundle.ts"],
    ["run", "scripts/smoke-release.ts"], ["run", "scripts/package.cjs"],
  ]);
  expect(commands.at(-1)).toEqual(["run", "scripts/package.cjs", "--runtime=validated-runtime"]);
});

test("failed relocation smoke never packages the artifact", async () => {
  const commands: string[][] = [];
  await expect(verifyBuild("validated-runtime", false, true, async args => {
    commands.push(args);
    if (args.includes("scripts/smoke-release.ts")) throw new Error("invalid relocation");
  })).rejects.toThrow("invalid relocation");
  expect(commands.some(args => args.includes("scripts/package.cjs"))).toBe(false);
});
