const { spawn } = require("node:child_process");

const MAX_CAPTURE_CHARS = 8 * 1024 * 1024;

function appendBounded(current, chunk) {
  const combined = current + String(chunk);
  return combined.length <= MAX_CAPTURE_CHARS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_CHARS);
}

function processFailure(stage, code, signal, stdout, stderr) {
  const detail = stderr.trim() || stdout.trim() || "no output";
  const status = code === null ? `signal ${signal || "unknown"}` : `status ${code}`;
  return new Error(`${stage} failed with ${status}: ${detail}`);
}

function runObservedProcess(command, args, options = {}) {
  const stage = options.stage || "package process";
  const stageKey = stage.replace(/\s+/g, "_");
  const timeoutMs = options.timeoutMs || 45_000;
  const heartbeatMs = options.heartbeatMs || 30_000;
  const logger = options.logger || ((line) => process.stdout.write(`${line}\n`));
  const spawnProcess = options.spawnProcess || spawn;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid ?? "unknown";

    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      logger(`PACKAGE_SMOKE_PROCESS_ENDED stage=${stageKey} pid=${pid} elapsed_ms=${elapsedMs} status=${code ?? signal ?? "unknown"}`);
      if (timedOut) return;
      if (code !== 0) {
        finish(processFailure(stage, code, signal, stdout, stderr));
        return;
      }
      finish(undefined, { stdout, stderr, elapsedMs });
    });

    logger(`PACKAGE_SMOKE_PROCESS_STARTED stage=${stageKey} pid=${pid} timeout_ms=${timeoutMs}`);
    const heartbeat = setInterval(() => {
      logger(`PACKAGE_SMOKE_PROCESS_WAIT stage=${stageKey} pid=${pid} elapsed_ms=${Date.now() - startedAt}`);
    }, heartbeatMs);
    heartbeat.unref?.();
    const timeout = setTimeout(() => {
      timedOut = true;
      const elapsedMs = Date.now() - startedAt;
      child.kill("SIGKILL");
      const detail = stderr.trim() || stdout.trim() || "no output";
      const error = new Error(`${stage} timed out after ${elapsedMs}ms (pid ${pid}): ${detail}`);
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
  });
}

module.exports = { runObservedProcess };
