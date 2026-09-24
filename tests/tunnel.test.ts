import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import * as config from "../src/config";
import * as commands from "../src/process";
import { TUNNEL_VERSION, installTunnelClient, parseTunnelStatus, stopTunnel, tunnelClientInstallAction, tunnelCommandOutput, tunnelConnectLaunchError } from "../src/tunnel";

test("a failed tunnel stop trusts OS exit evidence, never the inventory's cleared PID", () => {
  const appConfig = { mode: "full", tunnel: { binaryPath: process.execPath, alias: "ours" } } as config.AppConfig;
  const command = spyOn(commands, "runCommand");
  const probe = spyOn(process, "kill");
  try {
    for (const [code, alias, stopError, accepted] of [
      ["ESRCH", "ours", "process 123 did not exit after SIGTERM", true],
      [undefined, "ours", "process 123 did not exit after SIGTERM", false],
      ["EPERM", "ours", "process 123 did not exit after SIGTERM", false],
      ["EIO", "ours", "process 123 did not exit after SIGTERM", false],
      ["ESRCH", "other", "process 123 did not exit after SIGTERM", false],
      ["ESRCH", "ours", "process 0 did not exit after SIGTERM", false],
      ["ESRCH", "ours", "permission denied", false],
    ] as const) {
      command.mockReset();
      probe.mockReset();
      command.mockReturnValue({ status: 2, stderr: "", stdout: JSON.stringify({
        alias, stop_error: stopError, process_running: false, runtime_state: "stopped", stopped: false,
      }) });
      probe.mockImplementation((pid, signal) => {
        expect(pid).toBe(123);
        expect(signal).toBe(0);
        if (code) throw Object.assign(new Error("OS probe"), { code });
        return true;
      });
      if (accepted) expect(() => stopTunnel(appConfig)).not.toThrow();
      else expect(() => stopTunnel(appConfig)).toThrow("Failed to stop tunnel runtime");
      expect(command.mock.calls.map(call => call[1])).toEqual([["runtimes", "stop", "ours", "--json"]]);
    }
  } finally { command.mockRestore(); probe.mockRestore(); }
});

async function withTunnelInstall(
  platform: "win32" | "darwin",
  run: (fixture: {
    root: string; executable: string; stale: string; binary: Uint8Array;
    remove: ReturnType<typeof spyOn<typeof fs, "rmSync">>;
    download: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
    verify: ReturnType<typeof spyOn<typeof commands, "runChecked">>;
    write: ReturnType<typeof spyOn<typeof config, "atomicWriteFile">>;
    originalRemove: typeof fs.rmSync; originalWrite: typeof config.atomicWriteFile;
  }) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(join(tmpdir(), "tunnel-install-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const name = platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  const executable = join(root, "bin", name);
  const stale = `${executable}.install-${process.pid}-unrelated`;
  const binary = new TextEncoder().encode("verified fixture binary");
  const archive = zipSync({ [name]: binary });
  const asset = `tunnel-client-v${TUNNEL_VERSION}-${platform === "win32" ? "windows" : platform}-${process.arch === "arm64" ? "arm64" : "amd64"}.zip`;
  const sums = `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`;
  fs.mkdirSync(join(root, "bin"));
  fs.writeFileSync(stale, "Unrelated previous staging file");
  const originalRemove = fs.rmSync;
  const originalWrite = config.atomicWriteFile;
  const home = spyOn(config, "getConfigDir").mockReturnValue(root);
  const download = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (url: Parameters<typeof fetch>[0]) => new Response(String(url).endsWith("SHA256SUMS.txt") ? sums : archive),
    { preconnect: globalThis.fetch.preconnect },
  ));
  const remove = spyOn(fs, "rmSync");
  const verify = spyOn(commands, "runChecked").mockReturnValue({ status: 0, stdout: TUNNEL_VERSION, stderr: "" });
  const write = spyOn(config, "atomicWriteFile");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    await run({ root, executable, stale, binary, remove, download, verify, write, originalRemove, originalWrite });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    for (const mock of [home, download, remove, verify, write]) mock.mockRestore();
    originalRemove(root, { recursive: true, force: true });
  }
}

test("tunnel installation retries only transient Windows cleanup failures and leaves other staging files alone", async () => {
  for (const [platform, code, transient] of [
    ["win32", "EBUSY", true], ["win32", "EPERM", true],
    ["win32", "EBUSY", false], ["win32", "EACCES", false], ["darwin", "EBUSY", false],
  ] as const) await withTunnelInstall(platform, async fixture => {
    let attempts = 0;
    const locked = Object.assign(new Error("fixture cleanup failed"), { code });
    fixture.remove.mockImplementation((path, options) => {
      if (String(path).includes(".install-")) {
        attempts++;
        if (!transient || attempts === 1) throw locked;
      }
      fixture.originalRemove(path, options);
    });
    if (transient) {
      expect(await installTunnelClient()).toBe(fixture.executable);
      expect(fs.readFileSync(fixture.executable)).toEqual(Buffer.from(fixture.binary));
      expect(attempts).toBe(2);
      // A valid existing installation still reuses its binary without downloading again.
      const downloads = fixture.download.mock.calls.length;
      expect(await installTunnelClient()).toBe(fixture.executable);
      expect(fixture.download.mock.calls.length).toBe(downloads);
    } else {
      await expect(installTunnelClient()).rejects.toBe(locked);
      expect(attempts).toBe(platform === "win32" && code === "EBUSY" ? 6 : 1);
      expect(fs.existsSync(fixture.executable)).toBe(false);
    }
    expect(fs.readFileSync(fixture.stale, "utf8")).toBe("Unrelated previous staging file");
  });
}, 10_000);

test("tunnel verification and install errors survive failed cleanup and rollback", async () => {
  for (const phase of ["verification", "installation", "upgrade"] as const) await withTunnelInstall("win32", async fixture => {
    const primary = new Error(`fixture ${phase} failure`);
    const cleanup = Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" });
    const manifest = join(fixture.root, "bin", "tunnel-client-manifest.json");
    let writes = 0;
    if (phase === "upgrade") {
      fs.writeFileSync(fixture.executable, "trusted old binary");
      fs.writeFileSync(manifest, JSON.stringify({ version: 1, tunnelClientVersion: "0.0.10",
        binarySha256: createHash("sha256").update("trusted old binary").digest("hex") }));
      fixture.verify.mockImplementation(path => ({ status: 0, stdout: path === fixture.executable ? "0.0.10" : TUNNEL_VERSION, stderr: "" }));
    }
    if (phase === "verification") fixture.verify.mockImplementation(() => { throw primary; });
    else fixture.write.mockImplementation((path, data, options) => {
      if (path === manifest) throw primary;
      if (path === fixture.executable && ++writes === 2) throw cleanup;
      fixture.originalWrite(path, data, options);
    });
    fixture.remove.mockImplementation((path, options) => {
      if (phase === "verification" ? String(path).includes(".install-") : phase === "installation" && path === fixture.executable) throw cleanup;
      fixture.originalRemove(path, options);
    });
    const failure = await installTunnelClient().catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([primary, cleanup]);
    expect(failure.message).toContain(primary.message);
    expect(failure.message).toContain(cleanup.message);
    expect(fs.existsSync(manifest)).toBe(phase === "upgrade");
  });
});

test("pins the fixed tunnel-client and migrates only the previously shipped version", () => {
  expect(TUNNEL_VERSION).toBe("0.0.12");
  expect(tunnelClientInstallAction("0.0.12")).toBe("reuse");
  expect(tunnelClientInstallAction("0.0.10")).toBe("upgrade");
  expect(() => tunnelClientInstallAction("0.0.11")).toThrow("not a trusted upgrade source");
  expect(() => tunnelClientInstallAction("9.9.9")).toThrow("not a trusted upgrade source");
});

describe("tunnel status boundary", () => {
  test("requires the exact alias to have a locally verified ready runtime", () => {
    expect(parseTunnelStatus(JSON.stringify({
      entries: [{ alias: "ours", runtime_state: "ready" }],
    }), "ours")).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    });
    for (const state of ["stopped", "starting", "healthy"]) {
      expect(parseTunnelStatus(JSON.stringify({ entries: [
        { alias: "other", runtime_state: "ready" }, { alias: "ours", runtime_state: state },
      ] }), "ours")).toMatchObject({
        ok: false, processRunning: state !== "stopped", healthy: state === "healthy", ready: false,
      });
    }
  });

  test("redacts tunnel ids and keys from safe diagnostics", () => {
    const result = parseTunnelStatus(
      "failed tunnel_0123456789abcdef0123456789abcdef with sk-secretsecretsecret",
      "ours",
      1,
    );
    expect(result.detail).toBe("failed [tunnel-id] with [redacted-key]");
    expect(result.detail).not.toContain("0123456789abcdef");
  });

  test("surfaces and redacts an immediate managed-runtime launch failure", () => {
    const detail = tunnelConnectLaunchError(JSON.stringify({
      running: false,
      healthy: false,
      ready: false,
      exit_code: 1,
      launch_diagnostics: {
        log_tail: "403 for tunnel_0123456789abcdef0123456789abcdef using sk-secretsecretsecret",
      },
    }));

    expect(detail).toBe(
      "running=false; healthy=false; ready=false; exit_code=1; runtime_log=403 for [tunnel-id] using [redacted-key]",
    );
  });

  test("accepts a healthy managed launch while setup waits for control-plane readiness", () => {
    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: true,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: false,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: false,
      ready: false,
    }))).toContain("running=true; healthy=false; ready=false");

    expect(tunnelConnectLaunchError("not json")).toBe("tunnel-client returned non-JSON connect output");
  });

  test("missing, ambiguous, or malformed local inventory cannot report ready", () => {
    const ready = { alias: "ours", runtime_state: "ready" };
    for (const output of ["invalid JSON", "{}", JSON.stringify({ entries: [ready, ready] }),
      JSON.stringify({ entries: [{ ...ready, runtime_state: "unknown" }] })]) {
      expect(parseTunnelStatus(output, "ours")).toMatchObject({ ok: false, ready: false });
      expect(parseTunnelStatus(output, "ours").detail).toContain("invalid local inventory");
    }
    expect(parseTunnelStatus(JSON.stringify({ entries: [{ ...ready, alias: "other" }] }), "ours"))
      .toMatchObject({ ok: false, processRunning: false, healthy: false, ready: false, state: "stopped" });
  });

  test("status diagnostics do not discard stderr when a failed command also wrote stdout", () => {
    expect(tunnelCommandOutput({
      status: 1,
      stdout: '{"partial":true}',
      stderr: "runtime process exited with status 1",
    })).toBe('runtime process exited with status 1\n{"partial":true}');
    expect(tunnelCommandOutput({
      status: 0,
      stdout: '{"ready":true}',
      stderr: "non-fatal warning",
    })).toBe('{"ready":true}');
  });
});
