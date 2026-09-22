import { expect, test } from "bun:test";
import { resolveLifecycleClientArgs } from "../scripts/lifecycle-sim/entry";

test("default lifecycle lanes resolve pinned clients through one shared entry", async () => {
  let fixtureReads = 0;
  const args = await resolveLifecycleClientArgs(["--lane=all"], async () => {
    fixtureReads++;
    return { codex: "fixture/codex", claude: "fixture/claude", pi: "fixture/pi.js", node: "fixture/node" };
  });

  expect(fixtureReads).toBe(1);
  expect(args).toEqual([
    "--lane=all",
    "--codex=fixture/codex",
    "--claude=fixture/claude",
    "--pi=fixture/pi.js",
    "--node=fixture/node",
  ]);
});

test("explicit latest-client paths bypass the pinned fixture", async () => {
  let installs = 0;
  const args = ["--lane=all", "--codex=/latest/codex", "--claude=/latest/claude", "--pi=/latest/pi.js", "--node=/latest/node"];
  const resolved = await resolveLifecycleClientArgs(args, async () => {
    installs++;
    throw new Error("explicit clients must not install the pinned fixture");
  });

  expect(installs).toBe(0);
  expect(resolved).toEqual(args);
});

test("a single lane adds only its missing client argument from the shared fixture", async () => {
  let fixtureReads = 0;
  const args = await resolveLifecycleClientArgs(["--lane=codex"], async () => {
    fixtureReads++;
    return { codex: "fixture/codex", claude: "fixture/claude", pi: "fixture/pi.js", node: "fixture/node" };
  });

  expect(fixtureReads).toBe(1);
  expect(args).toEqual(["--lane=codex", "--codex=fixture/codex"]);
});

test("empty explicit client paths fail closed instead of falling back to PATH", async () => {
  for (const argument of ["--codex=", "--claude=   ", "--pi=", "--node= "]) {
    let fixtureReads = 0;
    await expect(resolveLifecycleClientArgs(["--lane=all", argument], async () => {
      fixtureReads++;
      return { codex: "fixture/codex", claude: "fixture/claude", pi: "fixture/pi.js", node: "fixture/node" };
    })).rejects.toThrow("requires a non-empty executable path");
    expect(fixtureReads).toBe(0);
  }
});

test("pi lane resolves only the real pi client and compatible Node", async () => {
  expect(await resolveLifecycleClientArgs(["--lane=pi"], async () => ({
    codex: "fixture/codex", claude: "fixture/claude", pi: "fixture/pi.js", node: "fixture/node",
  }))).toEqual(["--lane=pi", "--pi=fixture/pi.js", "--node=fixture/node"]);
});
