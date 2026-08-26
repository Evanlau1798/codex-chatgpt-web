import { join, resolve } from "node:path";

export type LifecycleSmokeLane = "codex" | "claude" | "all";

export interface LifecycleSmokeOptions {
  live: true;
  lane: LifecycleSmokeLane;
  artifactRoot: string;
  codexExecutable?: string;
  claudeExecutable?: string;
  launcherLog?: string;
  browserDescriptor?: string;
}

function valueOf(argument: string, name: string): string | undefined {
  const prefix = `--${name}=`;
  if (!argument.startsWith(prefix)) return undefined;
  const value = argument.slice(prefix.length).trim();
  if (!value) throw new Error(`Lifecycle smoke --${name} requires a value`);
  return value;
}

export function parseLifecycleSmokeOptions(args: string[], repo: string): LifecycleSmokeOptions {
  if (!args.includes("--live")) {
    throw new Error("Live lifecycle smoke uses an authenticated account; pass --live explicitly");
  }
  let lane: LifecycleSmokeLane = "codex";
  let artifactRoot = join(repo, "tmp", "lifecycle-smoke", "runs");
  let codexExecutable: string | undefined;
  let claudeExecutable: string | undefined;
  let launcherLog: string | undefined;
  let browserDescriptor: string | undefined;

  for (const argument of args) {
    if (argument === "--live") continue;
    const laneValue = valueOf(argument, "lane");
    if (laneValue !== undefined) {
      if (laneValue !== "codex" && laneValue !== "claude" && laneValue !== "all") {
        throw new Error(`Lifecycle smoke lane must be codex, claude, or all: ${laneValue}`);
      }
      lane = laneValue;
      continue;
    }
    const artifacts = valueOf(argument, "artifacts");
    if (artifacts !== undefined) { artifactRoot = resolve(artifacts); continue; }
    const codex = valueOf(argument, "codex");
    if (codex !== undefined) { codexExecutable = resolve(codex); continue; }
    const claude = valueOf(argument, "claude");
    if (claude !== undefined) { claudeExecutable = resolve(claude); continue; }
    const log = valueOf(argument, "launcher-log");
    if (log !== undefined) { launcherLog = resolve(log); continue; }
    const descriptor = valueOf(argument, "browser-descriptor");
    if (descriptor !== undefined) { browserDescriptor = resolve(descriptor); continue; }
    throw new Error(`Unknown lifecycle smoke option: ${argument}`);
  }

  return {
    live: true,
    lane,
    artifactRoot,
    ...(codexExecutable ? { codexExecutable } : {}),
    ...(claudeExecutable ? { claudeExecutable } : {}),
    ...(launcherLog ? { launcherLog } : {}),
    ...(browserDescriptor ? { browserDescriptor } : {}),
  };
}
