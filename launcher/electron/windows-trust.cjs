const tls = require("node:tls");

function windowsTrustEnvironment(environment, platform = process.platform) {
  const result = { ...environment };
  if (platform === "win32" && !Object.keys(result).some(key => key.toUpperCase() === "NODE_USE_SYSTEM_CA")) {
    result.NODE_USE_SYSTEM_CA = "1";
  }
  return result;
}

function configureWindowsTrust(platform = process.platform, environment = process.env, certificates = tls) {
  if (platform !== "win32") return;
  const setting = Object.entries(environment).find(([key]) => key.toUpperCase() === "NODE_USE_SYSTEM_CA")?.[1];
  if (setting !== undefined && setting !== "1") return;
  // Other children (including the Electron Node helper) need this at process startup.
  if (setting === undefined) environment.NODE_USE_SYSTEM_CA = "1";
  // The main process is already running: changing its startup environment cannot
  // configure Node's HTTPS client. Preserve its bundled/extra roots and add the OS roots.
  certificates.setDefaultCACertificates([
    ...certificates.getCACertificates("default"),
    ...certificates.getCACertificates("system"),
  ]);
}

module.exports = { configureWindowsTrust, windowsTrustEnvironment };
