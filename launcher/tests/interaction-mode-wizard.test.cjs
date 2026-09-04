const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const wizard = source.slice(source.indexOf("function McpSurface("), source.indexOf("function SettingsSurface("));

test("inactive mode provisioning does not require the active Automatic catalog", () => {
  const expression = wizard.match(/<PrimaryButton\s+disabled=\{([^{}]+)\}\s+onClick=\{\(\) => void install\(\)\}/)[1];
  const disabled = new Function("busy", "manualInteraction", "configuringInactiveMode",
    "clientIntegrationInstalled", "snapshot", "credentialsConfigured", "replacingCredentials",
    "tunnelId", "runtimeKey", `return (${expression});`);
  for (const [manual, inactive, installed, catalog, expected] of [
    [false, true, true, false, false], [false, true, false, false, false],
    [false, false, true, false, true], [false, false, false, true, true],
    [false, false, true, true, false], [true, false, false, false, false],
  ]) {
    const args = [false, manual, inactive, installed, { state: { codexCatalogVerified: catalog } }, false, false, "tunnel", "key"];
    assert.equal(disabled(...args), expected);
    assert.equal(disabled(true, ...args.slice(1)), true);
    assert.equal(disabled(...args.slice(0, 8), "", ""), true);
  }
  assert.match(wizard, /manualInteraction \|\| configuringInactiveMode \|\| snapshot\.state\.codexCatalogVerified/);
  assert.match(wizard, /api!\.setupMcp\(\{\s*interactionMode,/);
});

test("ordinary MCP navigation drops an abandoned target in both directions", () => {
  const body = source.match(/const navigateSurface = \(next: Surface\) => \{([\s\S]*?)\n  \};/)[1];
  for (const active of ["automatic", "manual"]) {
    let target = active === "automatic" ? "manual" : "automatic";
    let surface = "settings";
    new Function("next", "setSurface", "setMcpTargetMode", "compactSidebar", "setSidebarOpen", body)(
      "mcp", next => { surface = next; }, next => { target = next; }, false, () => {},
    );
    assert.equal(surface, "mcp");
    assert.equal(target ?? active, active);
  }
  assert.match(source, /showMcp=\{\(\) => navigateSurface\("mcp"\)\}/);
  assert.match(source, /<McpSurface\s+key=\{mcpTargetMode \?\? snapshot\.state\.browserInteractionMode\}/);
  assert.match(source, /configureInteractionMode=\{\(mode\) => \{\s*setMcpTargetMode\(mode\);\s*setSurface\("mcp"\);/);
  assert.match(wizard, /configuringInactiveMode \? false : snapshot\.mcpCredentialsConfigured/);
  assert.match(wizard, /snapshot\.connectorNames\[interactionMode\]/);
});
