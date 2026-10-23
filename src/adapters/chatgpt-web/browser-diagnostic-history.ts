import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";

const RECENT_LIMIT = 10;
const FAILURE_RETENTION_MS = 3 * 24 * 60 * 60_000;
const FINISHED_CAPTURE_BUDGET_BYTES = 100 * 1024 * 1024;
const STATE_FILE = ".trace-state";

function ownerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Lack of permission is not proof that another helper has stopped.
    throw error;
  }
}

/** Keep three days of failures within 100 MB, ahead of recent successes; never prune a live capture. */
export function pruneBrowserDiagnosticHistory(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{6,137}$/.test(entry.name)) return [];
    const path = join(root, entry.name);
    try {
      let state: { status: "active" | "completed" | "failed"; pid: number } | undefined;
      try {
        state = JSON.parse(readFileSync(join(path, STATE_FILE), "utf8"));
        if (!state || !["active", "completed", "failed"].includes(state.status)
          || !Number.isSafeInteger(state.pid) || state.pid <= 0) {
          throw new Error("Invalid browser diagnostic lifecycle state");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (state?.status === "active" && ownerIsAlive(state.pid)) return [];
      // Existing captures already record failure in their checkpoint filenames.
      // A dead owner without a terminal checkpoint is an interrupted capture.
      const failed = state ? state.status !== "completed" : readdirSync(path)
        .some(name => /^\d+-(?:turn|connector-verification)-failed\.json$/.test(name));
      return [{ path, failed, modifiedAt: statSync(path).mtimeMs }];
    } catch (error) {
      // Other browser helpers can finish cleanup while this one enumerates.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }).sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
  const cutoff = Date.now() - FAILURE_RETENTION_MS;
  const candidates = [
    ...traces.filter(trace => trace.failed && trace.modifiedAt >= cutoff),
    ...traces.filter(trace => !trace.failed).slice(0, RECENT_LIMIT),
  ];
  const keep = new Set<string>();
  let remainingBytes = FINISHED_CAPTURE_BUDGET_BYTES;
  for (const trace of candidates) {
    try {
      // Captures contain flat checkpoint files. Ignore symlinks and never follow
      // them into other directories when measuring the finished-history budget.
      const bytes = readdirSync(trace.path, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .reduce((total, entry) => total + statSync(join(trace.path, entry.name)).size, 0);
      if (bytes > remainingBytes) continue;
      keep.add(trace.path);
      remainingBytes -= bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const trace of traces) {
    if (!keep.has(trace.path)) rmSync(trace.path, { recursive: true, force: true });
  }
}

export class BrowserDiagnosticHistory {
  private initialized = false;

  constructor(readonly root: string, readonly directory: string) {}

  start(): void {
    if (this.initialized) return;
    for (const directory of [this.root, this.directory]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { chmodSync(directory, 0o700); } catch { /* Windows uses installer ACLs. */ }
    }
    atomicWriteFile(join(this.directory, STATE_FILE), JSON.stringify({ status: "active", pid: process.pid }));
    this.initialized = true;
  }

  finish(status: "completed" | "failed"): void {
    if (!this.initialized) return;
    atomicWriteFile(join(this.directory, STATE_FILE), JSON.stringify({ status, pid: process.pid }));
    pruneBrowserDiagnosticHistory(this.root);
  }
}
