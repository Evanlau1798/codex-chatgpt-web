import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface PackageMetadata {
  version?: string;
  packageManager?: string;
  engines?: Record<string, string>;
}

function packageMetadata(root: string): PackageMetadata {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageMetadata;
}

function forkVersion(root: string): string {
  const version = packageMetadata(root).version;
  if (!version) throw new Error("package.json has no version");
  if (!/^\d+\.\d+\.\d+-Enhanced\.\d+$/.test(version)) {
    throw new Error(`Fork releases must use the <upstream>-Enhanced.<revision> convention, received ${version}`);
  }
  return version;
}

function replaceRequired(source: string, pattern: RegExp, replacement: string, path: string): string {
  const updated = source.replace(pattern, replacement);
  if (updated === source && !pattern.test(source)) throw new Error(`${path} has no version metadata field`);
  return updated;
}

export function synchronizeVersionMetadata(root: string): string[] {
  const version = forkVersion(root);
  const targets = [
    {
      path: "launcher/package.json",
      pattern: /^(\s*"version"\s*:\s*)"[^"\r\n]*"/m,
      replacement: `$1${JSON.stringify(version)}`,
    },
    {
      path: "scripts/install.sh",
      pattern: /^VERSION="\$\{CODEX_CHATGPT_WEB_VERSION:-[^}\r\n]+\}"$/m,
      replacement: `VERSION="\${CODEX_CHATGPT_WEB_VERSION:-${version}}"`,
    },
  ];
  const changed: string[] = [];
  for (const target of targets) {
    const path = resolve(root, target.path);
    const source = readFileSync(path, "utf8");
    const updated = replaceRequired(source, target.pattern, target.replacement, target.path);
    if (updated === source) continue;
    writeFileSync(path, updated);
    changed.push(target.path);
  }
  return changed;
}

function checkVersion(root: string): void {
  const packageJson = packageMetadata(root);
  const packageVersion = forkVersion(root);
  const packageManagerMatch = /^bun@((\d+\.\d+\.\d+)\+([0-9a-f]+))$/.exec(packageJson.packageManager ?? "");
  if (!packageManagerMatch) throw new Error("package.json must pin an exact Bun stable revision");
  const bunRevision = packageManagerMatch[1];
  const bunVersion = packageManagerMatch[2];
  const revision = Bun.spawnSync([process.execPath, "--revision"], { stdout: "pipe", stderr: "pipe" });
  const reportedRevision = revision.stdout.toString().trim();
  if (revision.exitCode !== 0 || Bun.version !== bunVersion || reportedRevision !== bunRevision) {
    throw new Error(`Expected Bun ${bunRevision}, received ${reportedRevision || Bun.version}`);
  }
  if (packageJson.engines?.bun !== bunVersion) throw new Error(`engines.bun is not synchronized to ${bunVersion}`);
  const expected = [
    ["src/version.ts", 'from "../package.json" with { type: "json" }'],
    ["src/adapters/chatgpt-web/mcp-server.ts", "version: VERSION"],
    ["scripts/install.sh", `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${packageVersion}}\"`],
    ["README.md", `requires Bun ${bunRevision}.`],
    ["scripts/install.sh", "Bun.md"],
    ["scripts/generate-third-party-notices.ts", "CODEX_CHATGPT_WEB_EMBEDDED_BUN_VERSION"],
    ["scripts/prepare-windows-baseline-bun.ps1", `bun-v$Version`],
    [".github/workflows/ci.yml", `bun-version: ${bunVersion}`],
    [".github/workflows/release.yml", "Bun.md"],
  ] as const;
  for (const [path, needle] of expected) {
    if (!readFileSync(resolve(root, path), "utf8").includes(needle)) throw new Error(`${path} is not synchronized to ${packageVersion}`);
  }
  const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
  const bunSetupCount = releaseWorkflow.match(/uses: oven-sh\/setup-bun@v2/g)?.length ?? 0;
  const pinnedBunCount = releaseWorkflow.split(`bun-version: ${bunVersion}`).length - 1;
  if (bunSetupCount === 0 || pinnedBunCount !== bunSetupCount) {
    throw new Error("release.yml must pin the stable Bun version for every setup-bun step");
  }
  const launcherVersion = packageMetadata(resolve(root, "launcher")).version;
  if (launcherVersion !== packageVersion) throw new Error(`launcher/package.json is not synchronized to ${packageVersion}`);
  process.stdout.write(`VERSION_SYNC_OK ${packageVersion} bun@${bunRevision}\n`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  if (process.argv.includes("--write")) {
    const changed = synchronizeVersionMetadata(root);
    process.stdout.write(`VERSION_METADATA_WRITTEN ${changed.join(",") || "none"}\n`);
  }
  checkVersion(root);
}
