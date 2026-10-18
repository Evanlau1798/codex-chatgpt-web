const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { tunnelProxyFromPac, tunnelConnectionEnvironment } = require("../electron/tunnel-proxy.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

test("the actual tunnel child retains proxy, handshake, Windows trust and bounded MCP lifetime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-tunnel-env-"));
  const supervisor = Object.create(RuntimeSupervisor.prototype);
  supervisor.childEnvironment = (_name, _config, env = process.env) => ({ ...env, NODE_USE_SYSTEM_CA: "1" });
  try {
    const script = "console.log(JSON.stringify({proxy:process.env.HTTPS_PROXY,handshake:process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION,trust:process.env.NODE_USE_SYSTEM_CA,ttl:process.env.MCP_CONNECTION_MAX_TTL}))";
    const result = await supervisor.runTunnelCommand({ tunnel: { binaryPath: process.execPath, profileDir: root } },
      ["-e", script], 5_000, "environment probe", { ...process.env, HTTPS_PROXY: "http://proxy.invalid:8080",
        MCP_STDIO_SEND_INITIALIZED_NOTIFICATION: "true", MCP_CONNECTION_MAX_TTL: "unbounded" });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      proxy: "http://proxy.invalid:8080", handshake: "true", trust: "1", ttl: "24h",
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("uses exactly the first PAC route and rejects unusable routes without going direct", () => {
  for (const [pac, expected] of [
    ["DIRECT; PROXY unused:8080", undefined],
    ["PROXY proxy.example:8080; DIRECT", "http://proxy.example:8080/"],
    ["HTTPS proxy.example:443", "https://proxy.example/"],
    ["SOCKS5 [::1]:1080", "socks5://[::1]:1080"],
  ]) assert.equal(tunnelProxyFromPac(pac), expected);
  for (const pac of [
    "", null, "SOCKS old-proxy:1080; DIRECT", "QUIC proxy:443; PROXY other:80",
    "PROXY secret:password@proxy:8080", "PROXY host:0", "PROXY host:65536",
    "PROXY host:80/path", "PROXY host:80#secret", "PROXY [broken]:80", "x".repeat(4097),
  ]) assert.throws(() => tunnelProxyFromPac(pac), error =>
    error.message.startsWith("Tunnel proxy:") && !error.message.includes("secret"));
});

for (const platform of ["linux", "darwin", "win32"]) test(`system lookup preserves the target and bypasses without mutating parent env on ${platform}`, async () => {
  const env = { CONTROL_PLANE_BASE_URL: "https://gateway.example", no_proxy: "intranet.example", KEEP: "value" };
  const calls = [];
  const result = await tunnelConnectionEnvironment({ env, platform, resolveProxy: async url => {
    calls.push(url);
    return "PROXY proxy.example:8080; DIRECT";
  } });
  assert.deepEqual(calls, ["https://gateway.example/"]);
  assert.equal(result.baseURL, "https://gateway.example");
  assert.equal(result.env.HTTPS_PROXY, "http://proxy.example:8080/");
  assert.equal(result.env[platform === "win32" ? "NO_PROXY" : "no_proxy"], "intranet.example");
  assert.equal(result.env[platform === "win32" ? "no_proxy" : "NO_PROXY"], undefined);
  assert.equal(result.env.KEEP, "value");
  assert.deepEqual(env, { CONTROL_PLANE_BASE_URL: "https://gateway.example", no_proxy: "intranet.example", KEEP: "value" });
  const direct = await tunnelConnectionEnvironment({ env: {}, platform, resolveProxy: async () => "DIRECT" });
  assert.deepEqual(direct.env, {});
  const proxy = await tunnelConnectionEnvironment({ env: {}, platform, resolveProxy: async () => "SOCKS5 localhost:1080" });
  assert.equal(proxy.env.NO_PROXY, "localhost,127.0.0.1,::1");
});

test("explicit proxy settings win without contacting PAC, including Windows mixed-case names", async () => {
  const forbiddenLookup = async () => { assert.fail("must not query the system proxy"); };
  for (const [name, value] of [
    ["HTTPS_PROXY", "http://user:password@explicit:8080"],
    ["https_proxy", "socks5h://explicit:1080"],
    ["CONTROL_PLANE_HTTP_PROXY", "env:PRIVATE_PROXY"],
    ["TUNNEL_CLIENT_HTTP_PROXY", "http://explicit:80"],
  ]) {
    const env = { [name]: value, NO_PROXY: "*" };
    const result = await tunnelConnectionEnvironment({ env, platform: "linux", resolveProxy: forbiddenLookup });
    assert.deepEqual(result.env, env);
  }
  const windows = await tunnelConnectionEnvironment({
    env: { Https_Proxy: "http://explicit:8080", No_Proxy: "intranet", Path: "C:\\Windows" },
    platform: "win32", resolveProxy: forbiddenLookup,
  });
  assert.deepEqual(windows.env, { HTTPS_PROXY: "http://explicit:8080", NO_PROXY: "intranet", Path: "C:\\Windows" });
  const all = await tunnelConnectionEnvironment({ env: { all_proxy: "socks5://user:password@explicit:1080", NO_PROXY: "*" }, resolveProxy: forbiddenLookup });
  assert.equal(all.env.HTTPS_PROXY, "socks5://user:password@explicit:1080");
  assert.equal(all.env.NO_PROXY, "*");
  const invalid = await tunnelConnectionEnvironment({ env: { ALL_PROXY: "socks4://secret:password@proxy:1080" }, resolveProxy: forbiddenLookup }).catch(e => e);
  assert.match(invalid.message, /invalid proxy/);
  assert.doesNotMatch(invalid.message, /secret|password/);
  const unix = await tunnelConnectionEnvironment({
    env: { control_plane_http_proxy: "http://ignored:8080" }, platform: "linux",
    resolveProxy: async () => "PROXY system:8080",
  });
  assert.equal(unix.env.HTTPS_PROXY, "http://system:8080/", "tunnel-specific variables are uppercase on Unix");
});

test("HTTP control planes use HTTP_PROXY; mTLS uses its actual host", async () => {
  let target;
  const result = await tunnelConnectionEnvironment({ env: { CONTROL_PLANE_BASE_URL: "http://gateway.example" }, resolveProxy: async url => {
    target = url;
    return "PROXY proxy:8080";
  } });
  assert.equal(target, "http://gateway.example/");
  assert.equal(result.env.HTTP_PROXY, "http://proxy:8080/");
  assert.equal(result.env.HTTPS_PROXY, undefined);
  await tunnelConnectionEnvironment({ env: { CONTROL_PLANE_CLIENT_CERT: "cert.pem", CONTROL_PLANE_CLIENT_KEY: "key.pem" }, resolveProxy: async url => {
    assert.equal(url, "https://mtls.api.openai.com/");
    return "DIRECT";
  } });
  await assert.rejects(tunnelConnectionEnvironment({ env: { CONTROL_PLANE_BASE_URL: "https://user:secret@host/path" } }), /must be an HTTP\(S\) host root/);
});

test("failed, missing and stalled system lookup fail explicitly without leaking resolver errors", async () => {
  for (const resolveProxy of [undefined, () => { throw new Error("secret PAC data"); }, () => new Promise(() => {})]) {
    await assert.rejects(tunnelConnectionEnvironment({ env: {}, resolveProxy, timeoutMs: 10 }), error =>
      error.message.startsWith("Tunnel proxy:") && !error.message.includes("secret"));
  }
});

test("tunnel control passes the resolved environment to a real child; local control needs no resolver", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-proxy-child-"));
  const supervisor = new RuntimeSupervisor({
    app: {}, logger: {}, sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "browser.json"),
    resolveProxy: () => { assert.fail("local status must not resolve proxies"); },
  });
  const config = { tunnel: { binaryPath: process.execPath, profileDir: root } };
  try {
    const { env } = await tunnelConnectionEnvironment({ env: {}, resolveProxy: async () => "PROXY localhost:8080" });
    const result = await supervisor.runTunnelCommand(config, ["-e", "console.log(JSON.stringify({proxy:process.env.HTTPS_PROXY,bypass:process.env.NO_PROXY}))"], 5_000, "proxy fixture", env);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { proxy: "http://localhost:8080/", bypass: "localhost,127.0.0.1,::1" });
    const local = await supervisor.runTunnelCommand(config, ["-e", "console.log('local control')"], 5_000, "local fixture");
    assert.equal(local.code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed startup wires PAC into connect and never spawns after resolution fails", async () => {
  const saved = {};
  const ownedNames = Object.keys(process.env).filter(key => /proxy|^CONTROL_PLANE_/i.test(key));
  for (const key of ownedNames) { saved[key] = process.env[key]; delete process.env[key]; }
  const root = os.tmpdir();
  const supervisor = new RuntimeSupervisor({
    app: {}, logger: {}, sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "unused.json"),
    resolveProxy: async url => { assert.equal(url, "https://api.openai.com/"); return "PROXY proxy.example:8080"; },
    runtimeInvocationFactory: () => ({ executable: process.execPath, args: ["fixture"] }),
  });
  let spawns = 0;
  supervisor.runTunnelCommand = async (_config, args, _timeout, _label, env) => {
    spawns++;
    assert.equal(args[args.indexOf("--control-plane-base-url") + 1], "https://api.openai.com");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example:8080/");
    assert.equal(process.env.HTTPS_PROXY, undefined);
    const parentSetting = process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION;
    const probe = await RuntimeSupervisor.prototype.runTunnelCommand.call(supervisor,
      _config, ["-e", "console.log(process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION)"],
      5_000, "initialization setting probe", env);
    assert.equal(probe.code, 0);
    assert.equal(probe.stdout.trim(), "true");
    assert.equal(process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION, parentSetting);
    return { code: 0 };
  };
  const config = { brokerSocketPath: "broker", tunnel: {
    alias: "fixture", profileName: "fixture", profileDir: root,
    binaryPath: process.execPath, tunnelId: "fixture", runtimeKeyFile: "fixture.key",
  } };
  try {
    assert.equal((await supervisor.runTunnelConnectCommand(config)).code, 0);
    supervisor.resolveProxy = async () => { throw new Error("private proxy details"); };
    await assert.rejects(supervisor.runTunnelConnectCommand(config), /could not resolve the system proxy/);
    assert.equal(spawns, 1);
  } finally { Object.assign(process.env, saved); }
});
