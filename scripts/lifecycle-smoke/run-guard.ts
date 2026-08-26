import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

type LifecycleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LifecycleLock {
  fd: number;
  path: string;
  record: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLifecycleLock(path: string): LifecycleLock {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = `${JSON.stringify({
      pid: process.pid,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`;
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, record); }
      catch (error) {
        closeSync(fd);
        try { unlinkSync(path); } catch {}
        throw error;
      }
      return { fd, path, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: { pid?: unknown };
      try { existing = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error(`Lifecycle smoke lock is corrupt and cannot be reclaimed safely: ${path}`); }
      if (typeof existing.pid !== "number" || processIsAlive(existing.pid)) {
        throw new Error(`Lifecycle smoke is already active: ${path}`);
      }
      try { unlinkSync(path); }
      catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`Lifecycle smoke lock could not be acquired safely: ${path}`);
}

export function releaseLifecycleLock(lock: LifecycleLock): void {
  closeSync(lock.fd);
  let current: string;
  try { current = readFileSync(lock.path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current !== lock.record) throw new Error(`Lifecycle smoke lock ownership changed: ${lock.path}`);
  unlinkSync(lock.path);
}

export async function fetchLifecycleHealth(
  url: string,
  timeoutMs = 10_000,
  fetcher: LifecycleFetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Lifecycle smoke health preflight timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
