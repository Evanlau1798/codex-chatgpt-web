import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherEventReader, unseenLauncherEvents } from "../scripts/lifecycle-smoke/launcher-event-reader";

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
  appendFileSync(active, event("2026-01-01T00:00:01.000Z", "two"));
  expect(reader.read([active]).map(value => value.event)).toEqual(["one", "two", "two"]);

  const rotated = `${active}.1`;
  renameSync(active, rotated);
  writeFileSync(active, event("2026-01-01T00:00:02.000Z", "three"));
  expect(reader.read([rotated, active]).map(value => value.event)).toEqual(["one", "two", "two", "three"]);
});

test("launcher event reader rejects an unbounded retained cache", () => {
  const root = join(tmpdir(), `lifecycle-launcher-events-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const active = join(root, "launcher.jsonl");
  writeFileSync(active, event("2026-01-01T00:00:00.000Z", "oversized"));
  expect(() => new LauncherEventReader({ maxRetainedBytes: 8 }).read([active])).toThrow("cache limit");
});

test("launcher event reader preserves UTF-8 characters split across polls", () => {
  const root = join(tmpdir(), `lifecycle-launcher-events-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const active = join(root, "launcher.jsonl");
  const line = Buffer.from(`${JSON.stringify({
    at: "2026-01-01T00:00:00.000Z", event: "message", detail: { message: "測試訊息" },
  })}\n`);
  const split = line.indexOf(Buffer.from("訊")) + 1;
  writeFileSync(active, line.subarray(0, split));
  const reader = new LauncherEventReader();
  expect(reader.read([active])).toEqual([]);
  appendFileSync(active, line.subarray(split));
  expect(reader.read([active])[0]?.detail?.message).toBe("測試訊息");
});

test("launcher event reader binds rotation identity to the opened file", () => {
  const root = join(tmpdir(), `lifecycle-launcher-events-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const active = join(root, "launcher.jsonl");
  const rotated = `${active}.1`;
  writeFileSync(active, event("2026-01-01T00:00:00.000Z", "one"));
  let rotatedDuringOpen = false;
  const reader = new LauncherEventReader({}, () => {
    if (rotatedDuringOpen) return;
    renameSync(active, rotated);
    writeFileSync(active, event("2026-01-01T00:00:01.000Z", "two"));
    rotatedDuringOpen = true;
  });

  expect(reader.read([active]).map(value => value.event)).toEqual(["one"]);
  expect(rotatedDuringOpen).toBeTrue();
  expect(reader.read([rotated, active]).map(value => value.event)).toEqual(["one", "two"]);
});

test("launcher event consumers observe late older rotation records exactly once", () => {
  const root = join(tmpdir(), `lifecycle-launcher-events-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root);
  const active = join(root, "launcher.jsonl");
  const rotated = `${active}.1`;
  writeFileSync(active, event("2026-01-01T00:00:01.000Z", "new"));
  const reader = new LauncherEventReader();
  const seen = new WeakSet<object>();
  expect(unseenLauncherEvents(reader.read([active]), seen).map(value => value.event)).toEqual(["new"]);

  writeFileSync(rotated, event("2026-01-01T00:00:00.000Z", "old"));
  expect(unseenLauncherEvents(reader.read([rotated, active]), seen).map(value => value.event)).toEqual(["old"]);
});
