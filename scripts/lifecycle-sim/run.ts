import { resolveLifecycleExecutable } from "../lifecycle-smoke/paths";
import { resolve } from "node:path";
import { claudeLifecycleTests, codexLifecycleTests, sharedLifecycleTests } from "./manifest";

type Lane = "codex" | "claude" | "pi" | "all";

const repo = resolve(import.meta.dir, "..", "..");

const executable = (name: "codex" | "claude" | "pi" | "node") =>
  process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
    || resolveLifecycleExecutable(name);

async function run(args: string[], cwd = repo): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Lifecycle command exited ${code}: ${args.slice(1).join(" ")}`);
}

export async function runLifecycleSimulation(
  lane: Lane,
  executable: (name: "codex" | "claude" | "pi" | "node") => string,
  runCommand: typeof run = run,
  passedRootTests: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!(["codex", "claude", "pi", "all"] as const).includes(lane)) {
    throw new Error("Lifecycle simulation lane must be codex, claude, pi, or all");
  }
  async function runTests(files: readonly string[]): Promise<void> {
    const remaining = files.filter(file => !passedRootTests.has(resolve(repo, file)));
    if (remaining.length) await runCommand([process.execPath, "test", ...remaining.map(file => file.replace(/^tests[\\/]/, ""))], resolve(repo, "tests"));
  }
  if (lane === "codex" || lane === "all") {
    const codex = executable("codex");
    await runCommand([process.execPath, "run", "scripts/smoke-codex-subagents.ts", "--v1", codex]);
    await runCommand([process.execPath, "run", "scripts/smoke-codex-subagents.ts", "--v2", codex]);
    await runCommand([process.execPath, "run", "scripts/smoke-codex-cancel.ts", codex]);
    await runCommand([process.execPath, "run", "scripts/smoke-codex-interrupt.ts", codex]);
    await runCommand([process.execPath, "run", "scripts/lifecycle-sim/compact-client.ts", codex]);
    await runTests(codexLifecycleTests);
    process.stdout.write("CODEX_DETERMINISTIC_LIFECYCLE_LANE_OK\n");
  }
  if (lane === "claude" || lane === "all") {
    await runCommand([process.execPath, "run", "scripts/lifecycle-sim/claude.ts", `--claude=${executable("claude")}`]);
    await runTests(claudeLifecycleTests);
    process.stdout.write("CLAUDE_DETERMINISTIC_LIFECYCLE_LANE_OK\n");
  }
  if (lane === "pi" || lane === "all") {
    await runCommand([process.execPath, "run", "scripts/check-chat-completions-pi.ts",
      `--pi=${executable("pi")}`, `--node=${executable("node")}`]);
    process.stdout.write("PI_DETERMINISTIC_LIFECYCLE_LANE_OK\n");
  }
  if (lane === "all") {
    await runTests(sharedLifecycleTests);
    process.stdout.write("ALL_DETERMINISTIC_LIFECYCLE_LANES_OK\n");
  }
}

if (import.meta.main) {
  await runLifecycleSimulation((process.argv.find(argument => argument.startsWith("--lane="))?.slice(7) ?? "all") as Lane, executable);
}
