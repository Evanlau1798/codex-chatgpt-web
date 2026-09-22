import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type LifecycleClientName = "codex" | "claude" | "pi";
export type LifecycleClientPaths = Record<LifecycleClientName | "node", string>;

export const pinnedLifecycleClients = {
  codex: { packageName: "@openai/codex", version: "0.155.1", output: "codex-cli 0.155.1" },
  claude: { packageName: "@anthropic-ai/claude-code", version: "2.1.260", output: "2.1.260 (Claude Code)" },
  pi: { packageName: "@earendil-works/pi-coding-agent", version: "0.87.0", output: "0.87.0" },
} as const;

const repo = resolve(import.meta.dir, "..", "..");
const fixtureRoot = join(
  repo,
  "tmp",
  "runtime-cache",
  "lifecycle-clients",
  `codex-${pinnedLifecycleClients.codex.version}_claude-${pinnedLifecycleClients.claude.version}_pi-${pinnedLifecycleClients.pi.version}`,
);

function requestedLane(args: string[]): LifecycleClientName | "all" {
  const lane = args.find(argument => argument.startsWith("--lane="))?.slice(7) ?? "all";
  if (lane !== "codex" && lane !== "claude" && lane !== "pi" && lane !== "all") {
    throw new Error("Lifecycle simulation lane must be codex, claude, pi, or all");
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
    "pi",
    "node",
  ] as const).map(name => {
    const prefix = `--${name}=`;
    const argument = args.find(value => value.startsWith(prefix));
    if (argument !== undefined && argument.slice(prefix.length).trim() === "") {
      throw new Error(`${prefix.slice(0, -1)} requires a non-empty executable path`);
    }
    return [name, argument !== undefined];
  })) as Record<LifecycleClientName | "node", boolean>;
  const needed = (["codex", "claude", "pi", "node"] as const).filter(name => (
    (lane === "all" || lane === name || (name === "node" && lane === "pi"))
      && !explicit[name]
  ));
  if (needed.length === 0) return [...args];
  const paths = await ensurePinned();
  return [...args, ...needed.map(name => `--${name}=${paths[name]}`)];
}

function executablePath(name: LifecycleClientName): string {
  if (name === "pi") return join(fixtureRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
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

async function compatibleNodePath(): Promise<string> {
  const cached = process.platform === "win32"
    ? join(repo, "tmp", "runtime-cache", "node", "22.19.0", "node-v22.19.0-win-x64", "node.exe")
    : undefined;
  const path = cached && existsSync(cached) ? cached : Bun.which("node");
  if (!path) throw new Error("Pi lifecycle requires Node >=22.19.0");
  const version = await commandOutput(path, ["--version"]);
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new Error(`Pi lifecycle requires Node >=22.19.0; found ${version}`);
  }
  return path;
}

async function fixtureIsValid(): Promise<boolean> {
  try {
    for (const name of ["codex", "claude", "pi"] as const) {
      const spec = pinnedLifecycleClients[name];
      const packagePath = join(fixtureRoot, "node_modules", ...spec.packageName.split("/"), "package.json");
      if (!existsSync(packagePath) || !existsSync(executablePath(name))) return false;
      const manifest = await Bun.file(packagePath).json() as { version?: unknown };
      if (manifest.version !== spec.version) return false;
      const actual = name === "pi"
        ? await commandOutput(await compatibleNodePath(), [executablePath(name), "--version"])
        : await commandOutput(executablePath(name), ["--version"]);
      if (actual !== spec.output) return false;
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
  const node = await compatibleNodePath();
  if (!await fixtureIsValid()) await installFixture();
  if (!await fixtureIsValid()) throw new Error("Pinned lifecycle client fixture failed identity verification");
  return { codex: executablePath("codex"), claude: executablePath("claude"), pi: executablePath("pi"), node };
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
