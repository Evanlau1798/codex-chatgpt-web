import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherEventReader } from "../scripts/lifecycle-smoke/launcher-event-reader";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function event(at: string, name: string): string {
  return `${JSON.stringify({ at, event: name })}\n`;
}

test("launcher event reader incrementally follows rotation without duplicating records", () => {
  const root = join(tmpdir(), `lifecycle-launcher-events-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const active = join(root, "launcher.jsonl");
  writeFileSync(active, event("2026-01-01T00:00:00.000Z", "one"));
  const reader = new LauncherEventReader();
  expect(reader.read([active]).map(value => value.event)).toEqual(["one"]);

  appendFileSync(active, event("2026-01-01T00:00:01.000Z", "two"));
  expect(reader.read([active]).map(value => value.event)).toEqual(["one", "two"]);

  const rotated = `${active}.1`;
  renameSync(active, rotated);
  writeFileSync(active, event("2026-01-01T00:00:02.000Z", "three"));
  expect(reader.read([rotated, active]).map(value => value.event)).toEqual(["one", "two", "three"]);
});

test("launcher event reader rejects an unbounded retained cache", () => {
  const root = join(tmpdir(), `lifecycle-launcher-events-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const active = join(root, "launcher.jsonl");
  writeFileSync(active, event("2026-01-01T00:00:00.000Z", "oversized"));
  expect(() => new LauncherEventReader({ maxRetainedBytes: 8 }).read([active])).toThrow("cache limit");
});
