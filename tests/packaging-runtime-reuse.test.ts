import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, win32 } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..", "launcher");
const script = join(root, "scripts", "package.cjs");
const require = createRequire(script);
const source = readFileSync(script, "utf8");
const verified = resolve(root, "..", "tmp", "verified-package-runtime");

function packageFixture(args: string[], invalid = false, code = source, aliases: Record<string, string> = {},
  windowsScriptDirectory?: string, absent: string[] = [], copy?: typeof cpSync) {
  const events: Array<{ kind: string; path?: string; identity?: unknown; options?: unknown }> = [];
  const fs = {
    readFileSync: () => readFileSync(join(root, "package.json"), "utf8"),
    realpathSync: (path: string) => aliases[path] ?? path,
    existsSync: (path: string) => !absent.includes(path),
    rmSync: (path: string) => { events.push({ kind: "remove", path }); },
    cpSync: (path: string, destination: string, options: Parameters<typeof cpSync>[2]) => {
      events.push({ kind: "copy", path, options }); copy?.(path, destination, options);
    },
    mkdirSync: () => {}, copyFileSync: () => {},
    mkdtempSync: () => "package-staging",
    readdirSync: (path: string) => path === "package-staging"
      ? [{ name: "codex-web-gpt-win-x64.exe", isFile: () => true }] : [],
  };
  let error: unknown;
  try {
    runInNewContext(code, {
      __dirname: windowsScriptDirectory ?? join(root, "scripts"),
      process: { argv: ["node", script, ...args], env: {}, platform: "win32", arch: "x64",
        exit: (code: number) => { throw new Error(`exit ${code}`); } },
      require: Object.assign((name: string) => {
        if (name === "node:fs") return fs;
        if (name === "node:path" && windowsScriptDirectory) return win32;
        if (name === "node:child_process") return { spawnSync: (_command: string, args: string[]) => {
          expect(args).toContain("never"); events.push({ kind: "builder" }); return { status: 0 };
        } };
        if (name === "../electron/runtime-install.cjs") return { validateRuntimeBundle: (path: string, identity: unknown) => {
          events.push({ kind: "validate", path, identity });
          if (invalid) throw new Error("tampered bundle");
        } };
        return require(name);
      }, { resolve: (name: string) => require.resolve(name) }),
    });
  } catch (cause) { error = cause; }
  return { events, error };
}

test("packaging reuses only an identity-validated bundle and validates the copied payload before builder", () => {
  const { events, error } = packageFixture([`--runtime=${verified}`]);
  expect(error).toBeUndefined();
  expect(events.map(event => event.kind).slice(0, 5)).toEqual(["validate", "remove", "copy", "validate", "builder"]);
  expect(events[0]?.path).toBe(verified);
  expect(events[1]?.path).toBe(join(root, "build", "runtime"));
  expect(events[3]?.identity).toEqual({ version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    platform: "win32", arch: "x64" });
});

test("verified runtime copying preserves symlink targets verbatim", () => {
  const {events, error} = packageFixture([`--runtime=${verified}`]);
  expect(error).toBeUndefined();
  expect(events.find(event => event.kind === "copy")?.options).toEqual({recursive:true, verbatimSymlinks:true});
});

test.skipIf(process.platform === "win32")("relocated runtime bin links resolve inside the copied bundle", () => {
  const fixture = mkdtempSync(resolve(root, "..", "tmp", "package-symlink-"));
  const input = join(fixture, "source"), output = join(fixture, "copy");
  try {
    mkdirSync(join(input, "app", "node_modules", ".bin"), {recursive:true});
    mkdirSync(join(input, "app", "node_modules", "which", "bin"), {recursive:true});
    writeFileSync(join(input, "app", "node_modules", "which", "bin", "node-which"), "fixture");
    symlinkSync("../which/bin/node-which", join(input, "app", "node_modules", ".bin", "node-which"));
    const {error} = packageFixture([`--runtime=${input}`], false, source, {}, undefined, [],
      (from, _to, options) => cpSync(from, output, options));
    expect(error).toBeUndefined();
    const link = join(output, "app", "node_modules", ".bin", "node-which");
    expect(readlinkSync(link)).toBe("../which/bin/node-which");
    expect(realpathSync(link)).toBe(realpathSync(join(output, "app", "node_modules", "which", "bin", "node-which")));
  } finally { rmSync(fixture, {recursive:true,force:true}); }
});

test("Windows namespace aliases and root boundaries preserve same-output reuse and reject overlap", () => {
  for (const launcher of ["G:\\fixture\\launcher", "\\\\server\\share\\launcher"]) {
    const output = win32.join(launcher, "build", "runtime");
    const directory = win32.join(launcher, "scripts");
    const same = packageFixture([`--runtime=${win32.toNamespacedPath(output)}`], false, source, {}, directory);
    expect(same.error).toBeUndefined();
    expect(same.events.some(event => event.kind === "remove" && event.path === output)).toBe(false);
    expect(same.events.some(event => event.kind === "copy")).toBe(false);
    for (const path of [win32.parse(output).root, win32.dirname(output), win32.join(output, "nested")]) {
      const result = packageFixture([`--runtime=${win32.toNamespacedPath(path)}`], false, source, {}, directory);
      expect(result.error).toBeDefined();
      expect(result.events.some(event => ["remove", "copy", "builder"].includes(event.kind))).toBe(false);
    }
    for (const path of [output + "2", "H:\\verified-runtime"]) {
      const result = packageFixture([`--runtime=${win32.toNamespacedPath(path)}`], false, source, {}, directory);
      expect(result.error).toBeUndefined();
      expect(result.events.some(event => event.kind === "copy")).toBe(true);
    }
  }
});

test("missing output is compared through its existing canonical parent before mutation", () => {
  const output = join(root, "build", "runtime");
  const parent = join(root, "build");
  const result = packageFixture([`--runtime=${join(verified, "runtime", "nested")}`], false, source,
    { [parent]: verified }, undefined, [output]);
  expect(result.error).toBeDefined();
  expect(result.events.some(event => ["remove", "copy", "builder"].includes(event.kind))).toBe(false);
});

test("invalid or relative verified runtime never replaces packaging output or starts builder", () => {
  for (const [args, invalid] of [[["--runtime=relative"], false], [[`--runtime=${verified}`], true]] as const) {
    const { events, error } = packageFixture([...args], invalid);
    expect(error).toBeDefined();
    expect(events.some(event => ["remove", "copy", "builder"].includes(event.kind))).toBe(false);
  }
});

test("standalone packaging still validates its ordinary runtime without copying another artifact", () => {
  const { events, error } = packageFixture([]);
  expect(error).toBeUndefined();
  expect(events[0]?.kind).toBe("validate");
  expect(events[0]?.path).toBe(join(root, "build", "runtime"));
  expect(events.some(event => event.kind === "copy")).toBe(false);
});

test("overlapping verified source is preserved instead of recursively replacing itself", () => {
  for (const path of [join(root, "build"), join(root, "build", "runtime", "nested")]) {
    const { events, error } = packageFixture([`--runtime=${path}`]);
    expect(error).toBeDefined();
    expect(events.some(event => ["remove", "copy", "builder"].includes(event.kind))).toBe(false);
  }
});

test("Windows case aliases of the output never delete the verified source", () => {
  const output = join(root, "build", "runtime");
  const { events, error } = packageFixture([`--runtime=${output.toUpperCase()}`]);
  expect(error).toBeUndefined();
  expect(events.some(event => event.kind === "builder")).toBe(true);
  expect(events.some(event => event.kind === "remove" && event.path === output)).toBe(false);
  expect(events.some(event => event.kind === "copy")).toBe(false);
  for (const path of [join(root, "build"), join(output, "nested")]) {
    const result = packageFixture([`--runtime=${path.toUpperCase()}`]);
    expect(result.error).toBeDefined();
    expect(result.events.some(event => ["remove", "copy", "builder"].includes(event.kind))).toBe(false);
  }
});

test("canonical output aliases cannot hide source overlap", () => {
  const output = join(root, "build", "runtime");
  const result = packageFixture([`--runtime=${join(verified, "nested")}`], false, source, { [output]: verified });
  expect(result.error).toBeDefined();
  expect(result.events.some(event => ["remove", "copy", "builder"].includes(event.kind))).toBe(false);
});
