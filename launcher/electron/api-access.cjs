const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

function files(coreHome) {
  if (typeof coreHome !== "string" || !path.isAbsolute(coreHome)) {
    throw new Error("Launcher API Access requires an absolute profile path");
  }
  const directory = path.join(coreHome, "api-access");
  return { state: path.join(directory, "state.json"), key: path.join(directory, "key") };
}

function readEnabled(coreHome) {
  const file = files(coreHome).state;
  if (!fs.existsSync(file)) return false;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.version !== 1 || typeof value.enabled !== "boolean") {
    throw new Error("Launcher API Access state is invalid");
  }
  return value.enabled;
}

function readKey(coreHome) {
  const file = files(coreHome).key;
  if (!fs.existsSync(file)) return null;
  const key = fs.readFileSync(file, "utf8");
  if (!/^sk-local-[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error("Launcher API Access key is invalid");
  }
  return key;
}

function writeEnabled(coreHome, enabled) {
  writePrivateFileAtomic(files(coreHome).state, `${JSON.stringify({ version: 1, enabled })}\n`);
}

function writeKey(coreHome, key) {
  writePrivateFileAtomic(files(coreHome).key, key);
}

function daemonApiKey(coreHome) {
  return readEnabled(coreHome) ? readKey(coreHome) : null;
}

function runtime(host) {
  const current = host.runtimeConfigSnapshot();
  if (!current.configured || current.owner !== "launcher") {
    throw new Error("Install the launcher-owned runtime before changing API Access");
  }
  if (current.config.host !== "127.0.0.1") {
    throw new Error("API Access requires a loopback runtime");
  }
  if (host.browserInteractionMode() !== "automatic") {
    throw new Error("API Access is available only in Automatic Web mode");
  }
  return current.config;
}

function keyForCopy(host) {
  runtime(host);
  return readKey(host.supervisor.coreHome);
}

function status(host) {
  const config = runtime(host);
  const enabled = readEnabled(host.supervisor.coreHome);
  const key = readKey(host.supervisor.coreHome);
  return {
    state: !enabled ? "disabled" : key ? "enabled" : "key_required",
    endpoint: `http://127.0.0.1:${config.port}/v1`,
    hasKey: key !== null,
    keyPreview: key ? `sk-local-${"*".repeat(16)}${key.slice(-5)}` : null,
  };
}

async function change(host, nextEnabled, nextKey) {
  const home = host.supervisor.coreHome;
  const previousEnabled = readEnabled(home);
  const previousKey = readKey(home);
  host.lifecycleOperation = "api-access-change";
  try {
    await host.supervisor.stopForSetup();
    try {
      if (nextKey !== previousKey) writeKey(home, nextKey);
      if (nextEnabled !== previousEnabled) writeEnabled(home, nextEnabled);
      const result = await host.supervisor.startIfConfigured();
      if (result.status !== "ready") throw new Error(`Local runtime is ${result.status}`);
    } catch (error) {
      try {
        if (nextKey !== previousKey) {
          if (previousKey) writeKey(home, previousKey);
          else fs.rmSync(files(home).key, { force: true });
        }
        if (nextEnabled !== previousEnabled) writeEnabled(home, previousEnabled);
        const recovered = await host.supervisor.startIfConfigured();
        if (recovered.status !== "ready") throw new Error(`Local runtime is ${recovered.status}`);
      } catch (recoveryError) {
        throw new Error(`API Access change failed: ${error.message}; runtime recovery failed: ${recoveryError.message}`);
      }
      throw error;
    }
    return status(host);
  } finally {
    host.lifecycleOperation = null;
  }
}

function assertAvailable(host) {
  runtime(host);
  if (host.currentOperation()) throw new Error(`Another launcher operation is active: ${host.currentOperation()}`);
}

async function setEnabled(host, enabled) {
  if (typeof enabled !== "boolean") throw new Error("API Access enabled value must be a boolean");
  assertAvailable(host);
  const home = host.supervisor.coreHome;
  const previous = readEnabled(home);
  if (previous === enabled) return status(host);
  const key = readKey(home);
  if (!key) {
    writeEnabled(home, enabled);
    return status(host);
  }
  return change(host, enabled, key);
}

async function generate(host) {
  assertAvailable(host);
  const home = host.supervisor.coreHome;
  if (!readEnabled(home)) throw new Error("Enable API Access before generating a key");
  if (readKey(home)) throw new Error("An API key already exists; use Reset Key to rotate it");
  return change(host, true, `sk-local-${randomBytes(32).toString("base64url")}`);
}

async function reset(host) {
  assertAvailable(host);
  const home = host.supervisor.coreHome;
  if (!readKey(home)) throw new Error("Generate an API key before resetting it");
  const next = `sk-local-${randomBytes(32).toString("base64url")}`;
  if (readEnabled(home)) return change(host, true, next);
  writeKey(home, next);
  return status(host);
}

module.exports = { daemonApiKey, status, setEnabled, generate, reset, keyForCopy };
