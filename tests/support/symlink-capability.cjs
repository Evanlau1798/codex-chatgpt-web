const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function canCreateFileSymlink() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-symlink-check-"));
  try {
    const target = path.join(root, "target");
    fs.writeFileSync(target, "test");
    fs.symlinkSync(target, path.join(root, "link"));
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return false;
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function shouldRunFileSymlinkTests() {
  if (!process.env.CI) return false;
  if (!canCreateFileSymlink()) throw new Error("CI runner cannot create file symlinks");
  return true;
}

module.exports = { shouldRunFileSymlinkTests };
