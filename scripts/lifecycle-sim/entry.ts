import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type LifecycleClientName = "codex" | "claude";
export type LifecycleClientPaths = Record<LifecycleClientName, string>;

export const pinnedLifecycleClients = {
  codex: { packageName: "@openai/codex", version: "0.155.1", output: "codex-cli 0.155.1" },
  claude: { packageName: "@anthropic-ai/claude-code", version: "2.1.260", output: "2.1.260 (Claude Code)" },
} as const;

const repo = resolve(import.meta.dir, "..", "..");
const fixtureRoot = join(
  repo,
  "tmp",
  "runtime-cache",
  "lifecycle-clients",
  `codex-${pinnedLifecycleClients.codex.version}_claude-${pinnedLifecycleClients.claude.version}`,
);

function requestedLane(args: string[]): "codex" | "claude" | "all" {
  const lane = args.find(argument => argument.startsWith("--lane="))?.slice(7) ?? "all";
  if (lane !== "codex" && lane !== "claude" && lane !== "all") {
    throw new Error("Lifecycle simulation lane must be codex, claude, or all");
  }
  return lane;
}

export async function resolveLifecycleClientArgs(
  args: string[],
  ensurePinned: () => Promise<LifecycleClientPaths>,
): Promise<string[]> {
  const lane = requestedLane(args);
  const explicit = Object.fromEntries(([
    "codex",
    "claude",
  ] as const).map(name => {
    const prefix = `--${name}=`;
    const argument = args.find(value => value.startsWith(prefix));
    if (argument !== undefined && argument.slice(prefix.length).trim() === "") {
      throw new Error(`${prefix.slice(0, -1)} requires a non-empty executable path`);
    }
    return [name, argument !== undefined];
  })) as Record<LifecycleClientName, boolean>;
  const needed = (["codex", "claude"] as const).filter(name => (
    (lane === "all" || lane === name)
      && !explicit[name]
  ));
  if (needed.length === 0) return [...args];
  const paths = await ensurePinned();
  return [...args, ...needed.map(name => `--${name}=${paths[name]}`)];
}

function executablePath(name: LifecycleClientName): string {
  return join(fixtureRoot, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const child = Bun.spawn([command, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

async function fixtureIsValid(): Promise<boolean> {
  try {
    for (const name of ["codex", "claude"] as const) {
      const spec = pinnedLifecycleClients[name];
      const packagePath = join(fixtureRoot, "node_modules", ...spec.packageName.split("/"), "package.json");
      if (!existsSync(packagePath) || !existsSync(executablePath(name))) return false;
      const manifest = await Bun.file(packagePath).json() as { version?: unknown };
      if (manifest.version !== spec.version) return false;
      if (await commandOutput(executablePath(name), ["--version"]) !== spec.output) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function installFixture(): Promise<void> {
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify({
    private: true,
    dependencies: Object.fromEntries(Object.values(pinnedLifecycleClients).map(spec => [
      spec.packageName,
      spec.version,
    ])),
  }, null, 2)}\n`);
  const npm = Bun.which(process.platform === "win32" ? "npm.cmd" : "npm") ?? Bun.which("npm");
  if (!npm) throw new Error("npm is required to install pinned lifecycle clients");
  const child = Bun.spawn([
    npm,
    "install",
    "--prefix",
    fixtureRoot,
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
  ], { cwd: repo, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Pinned lifecycle client installation failed (${code})`);
}

export async function ensurePinnedLifecycleClients(): Promise<LifecycleClientPaths> {
  if (!await fixtureIsValid()) await installFixture();
  if (!await fixtureIsValid()) throw new Error("Pinned lifecycle client fixture failed identity verification");
  return { codex: executablePath("codex"), claude: executablePath("claude") };
}

async function main(): Promise<void> {
  const args = await resolveLifecycleClientArgs(process.argv.slice(2), ensurePinnedLifecycleClients);
  const child = Bun.spawn([process.execPath, "run", "scripts/lifecycle-sim/run.ts", ...args], {
    cwd: repo,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}

if (import.meta.main) await main();
