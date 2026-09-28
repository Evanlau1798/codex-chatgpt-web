const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { configureWindowsTrust, windowsTrustEnvironment } = require("../electron/windows-trust.cjs");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

test("Windows trust preserves explicit settings and other platforms without changing the parent environment", () => {
  const original = { NODE_EXTRA_CA_CERTS: "custom.pem" };
  assert.deepEqual(windowsTrustEnvironment(original, "win32"), { ...original, NODE_USE_SYSTEM_CA: "1" });
  assert.deepEqual(original, { NODE_EXTRA_CA_CERTS: "custom.pem" });
  for (const value of ["0", "1", ""]) for (const key of ["NODE_USE_SYSTEM_CA", "node_use_system_ca"]) {
    const explicit = { ...original, [key]: value };
    assert.deepEqual(windowsTrustEnvironment(explicit, "win32"), explicit);
  }
  for (const platform of ["linux", "darwin"]) assert.deepEqual(windowsTrustEnvironment(original, platform), original);
});

test("the already-running Windows launcher adds OS roots without replacing bundled or custom trust", () => {
  const installed = [];
  const certificates = {
    getCACertificates: type => type === "default" ? ["bundled", "custom"] : ["windows"],
    setDefaultCACertificates: roots => installed.push(roots),
  };
  for (const environment of [{}, { NODE_USE_SYSTEM_CA: "1" }]) configureWindowsTrust("win32", environment, certificates);
  assert.deepEqual(installed, [["bundled", "custom", "windows"], ["bundled", "custom", "windows"]]);
  for (const platform of ["darwin", "linux"]) configureWindowsTrust(platform, {}, certificates);
  for (const value of ["0", ""]) configureWindowsTrust("win32", { node_use_system_ca: value }, certificates);
  assert.equal(installed.length, 2);
});

test("runtime operations pass Windows trust before child startup and honor per-operation overrides", async () => {
  const host = Object.assign(Object.create(RuntimeHost.prototype), {
    platform: "win32", browserDescriptorPath: "fixture-descriptor",
    logger: { info() {}, warn() {}, error() {} },
    command: () => ({ executable: process.execPath, cwd: process.cwd(),
      args: ["-e", "process.stdout.write(process.env.NODE_USE_SYSTEM_CA ?? 'unset')"] }),
  });
  for (const [environment, env, expected] of [[{}, {}, "1"], [{ NODE_USE_SYSTEM_CA: "0" }, {}, "0"], [{}, { NODE_USE_SYSTEM_CA: "0" }, "0"]]) {
    assert.equal((await host.run("trust-check", [], { environment, env })).stdout, expected);
  }
  host.platform = "linux";
  assert.equal((await host.run("trust-check", [], { environment: {} })).stdout, "unset");
});

test("supervised Windows runtimes receive the same trust environment before startup", async () => {
  const previous = process.env.NODE_USE_SYSTEM_CA;
  const supervisor = Object.assign(Object.create(RuntimeSupervisor.prototype), {
    platform: "win32", browserDescriptorPath: "fixture-descriptor",
    coreHome: process.cwd(),
    lastChildFailure: {}, lastChildOutput: {}, expectedExits: new Set(), restartableChildren: new Set(),
    logger: { info() {}, warn() {}, error() {} }, writeState() {}, tryWriteState() { return true; },
  });
  try {
    for (const value of [undefined, "0"]) {
      if (value === undefined) delete process.env.NODE_USE_SYSTEM_CA;
      else process.env.NODE_USE_SYSTEM_CA = value;
      const child = supervisor.spawnChild("daemon", { executable: process.execPath, cwd: process.cwd(),
        args: ["-e", "process.stdout.write(process.env.NODE_USE_SYSTEM_CA ?? 'unset')"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      const [code] = await once(child, "close");
      assert.equal(code, 0);
      assert.equal(output, value ?? "1");
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_USE_SYSTEM_CA;
    else process.env.NODE_USE_SYSTEM_CA = previous;
  }
});
