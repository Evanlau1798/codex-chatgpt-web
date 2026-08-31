import { resolveLifecycleExecutable } from "../lifecycle-smoke/paths";
import { resolve } from "node:path";
import { claudeLifecycleTests, codexLifecycleTests, sharedLifecycleTests } from "./manifest";

type Lane = "codex" | "claude" | "all";

const repo = resolve(import.meta.dir, "..", "..");
const lane = (process.argv.find(argument => argument.startsWith("--lane="))?.slice(7) ?? "all") as Lane;
if (!(["codex", "claude", "all"] as const).includes(lane)) {
  throw new Error("Lifecycle simulation lane must be codex, claude, or all");
}

const executable = (name: "codex" | "claude") =>
  process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
    || resolveLifecycleExecutable(name);

async function run(args: string[], cwd = repo): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Lifecycle command exited ${code}: ${args.slice(1).join(" ")}`);
}

async function runTests(files: readonly string[]): Promise<void> {
  await run([process.execPath, "test", ...files.map(file => file.replace(/^tests[\\/]/, ""))], resolve(repo, "tests"));
}

async function codexLane(): Promise<void> {
  const codex = executable("codex");
  await run([process.execPath, "run", "scripts/smoke-codex-subagents.ts", "--v1", codex]);
  await run([process.execPath, "run", "scripts/smoke-codex-subagents.ts", "--v2", codex]);
  await run([process.execPath, "run", "scripts/smoke-codex-cancel.ts", codex]);
  await runTests(codexLifecycleTests);
  process.stdout.write("CODEX_DETERMINISTIC_LIFECYCLE_LANE_OK\n");
}

async function claudeLane(): Promise<void> {
  await run([process.execPath, "run", "scripts/lifecycle-sim/claude.ts", `--claude=${executable("claude")}`]);
  await runTests(claudeLifecycleTests);
  process.stdout.write("CLAUDE_DETERMINISTIC_LIFECYCLE_LANE_OK\n");
}

if (lane === "codex" || lane === "all") await codexLane();
if (lane === "claude" || lane === "all") await claudeLane();
if (lane === "all") {
  await runTests(sharedLifecycleTests);
  process.stdout.write("ALL_DETERMINISTIC_LIFECYCLE_LANES_OK\n");
}
