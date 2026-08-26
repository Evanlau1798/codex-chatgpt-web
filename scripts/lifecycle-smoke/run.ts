import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir, loadConfig } from "../../src/config";
import { parseLifecycleSmokeOptions } from "./options";
import { acquireLifecycleLock, fetchLifecycleHealth, lifecycleLockPath, releaseLifecycleLock } from "./run-guard";

const repo = resolve(import.meta.dir, "..", "..");
const options = parseLifecycleSmokeOptions(process.argv.slice(2), repo);
if (options.codexExecutable) process.env.CODEX_LIFECYCLE_CODEX_EXE = options.codexExecutable;
if (options.claudeExecutable) process.env.CODEX_LIFECYCLE_CLAUDE_EXE = options.claudeExecutable;
if (options.launcherLog) process.env.CODEX_LIFECYCLE_LAUNCHER_LOG = options.launcherLog;
if (options.browserDescriptor) {
  process.env.CODEX_LIFECYCLE_BROWSER_DESCRIPTOR = options.browserDescriptor;
}

function runId(): string {
  return `${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

mkdirSync(options.artifactRoot, { recursive: true });
const lockPath = lifecycleLockPath(getConfigDir());
const lock = acquireLifecycleLock(lockPath);

try {
  const config = loadConfig();
  const serviceBaseUrl = `http://${config.host}:${config.port}`;
  const healthResponse = await fetchLifecycleHealth(`${serviceBaseUrl}/healthz`);
  if (!healthResponse.ok) throw new Error(`Lifecycle smoke health preflight failed: HTTP ${healthResponse.status}`);
  const health = await healthResponse.json() as Record<string, unknown>;
  if (health.status !== "ok" || health.accepting_turns !== true) {
    throw new Error(`Lifecycle smoke requires a healthy accepting daemon: ${JSON.stringify(health)}`);
  }
  if (Number(health.active_http_turns ?? 0) !== 0 || Number(health.active_browser_turns ?? 0) !== 0) {
    throw new Error("Lifecycle smoke requires an idle daemon with zero active HTTP and browser turns");
  }
  if (config.browserHost !== "launcher" || !config.browserHostDescriptorPath) {
    throw new Error("Lifecycle smoke requires the launcher-owned browser host");
  }

  const [{ selfTest, save }, codexApp, codexLane, v2Activity, v2Scenario, retained, skill] = await Promise.all([
    import("./common"),
    import("./codex-app-server"),
    import("./codex-lane"),
    import("./codex-v2-activity"),
    import("./codex-v2-scenario"),
    import("./retained-check"),
    import("./skill-contract"),
  ]);
  await selfTest();
  codexApp.selfTestAgentTextStreamDiagnostic();
  codexApp.selfTestActiveTurnSmokeBudget();
  codexLane.selfTestCodexLaneBudget();
  v2Activity.selfTestV2ActivityNormalization();
  v2Scenario.selfTestHierarchySurfaceClassification();
  retained.selfTestManualCompactRetainedRoot();
  skill.selfTestSkillContract();

  const root = join(options.artifactRoot, runId());
  mkdirSync(root, { recursive: true });
  const results: unknown[] = [];
  if (options.lane === "codex" || options.lane === "all") {
    results.push(await codexLane.runCodexLane(root));
  }
  if (options.lane === "claude" || options.lane === "all") {
    const claudeLane = await import("./claude-lane");
    claudeLane.selfTestClaudeLaneBudget();
    results.push(await claudeLane.runClaudeLane(root));
  }
  const failed = results.some(result => (
    typeof result === "object" && result !== null && (result as { status?: unknown }).status !== "passed"
  ));
  await save(join(root, "result.json"), {
    status: failed ? "failed" : "passed",
    lane: options.lane,
    startedWith: {
      service: serviceBaseUrl,
      version: health.version,
      pid: health.pid,
    },
    results,
  });
  process.stdout.write(`LIFECYCLE_SMOKE_${failed ? "FAILED" : "PASSED"} root=${root}\n`);
  if (failed) process.exitCode = 1;
} finally {
  releaseLifecycleLock(lock);
}
