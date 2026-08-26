import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseLifecycleSmokeOptions } from "../scripts/lifecycle-smoke/options";

test("live lifecycle smoke requires an explicit live acknowledgement", () => {
  expect(() => parseLifecycleSmokeOptions([], "C:\\repo")).toThrow("--live");
});

test("live lifecycle smoke defaults to the Codex lane and tmp artifacts", () => {
  expect(parseLifecycleSmokeOptions(["--live"], "C:\\repo")).toEqual({
    live: true,
    lane: "codex",
    artifactRoot: join("C:\\repo", "tmp", "lifecycle-smoke", "runs"),
  });
});

test("live lifecycle smoke accepts portable executable and launcher overrides", () => {
  expect(parseLifecycleSmokeOptions([
    "--live",
    "--lane=all",
    "--artifacts=D:\\smoke",
    "--codex=D:\\bin\\codex.exe",
    "--claude=D:\\bin\\claude.exe",
    "--launcher-log=D:\\logs\\launcher.jsonl",
    "--browser-descriptor=D:\\runtime\\browser.json",
  ], "C:\\repo")).toEqual({
    live: true,
    lane: "all",
    artifactRoot: "D:\\smoke",
    codexExecutable: "D:\\bin\\codex.exe",
    claudeExecutable: "D:\\bin\\claude.exe",
    launcherLog: "D:\\logs\\launcher.jsonl",
    browserDescriptor: "D:\\runtime\\browser.json",
  });
});

test("live lifecycle smoke rejects unknown lanes and flags", () => {
  expect(() => parseLifecycleSmokeOptions(["--live", "--lane=other"], "C:\\repo"))
    .toThrow("lane");
  expect(() => parseLifecycleSmokeOptions(["--live", "--wat"], "C:\\repo"))
    .toThrow("Unknown lifecycle smoke option");
});
