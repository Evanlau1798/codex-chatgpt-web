const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { copyFor } = require("./support/i18n.cjs")();

test("installed integration can connect MCP while its native catalog is still refreshing", async () => {
  const text = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const ast = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["SetupSurface", "McpSurface", "hasClientIntegration", "hasVerifiedClientIntegration"]);
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(selected.length, 4);
  const program = selected.map(node => node.getText(ast)).join("\n");
  const js = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "element" } }).outputText;
  let connected = 0;
  const sandbox = {
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: value => [value, () => {}], useMemo: callback => callback(), useEffect() {},
    React: { Fragment: "Fragment" }, AnimatePresence: "AnimatePresence", motion: { section: "section" },
    PANEL_TRANSITION: {}, MCP_GUIDE_MEDIA: ["fixture", "fixture", "fixture"], messageOf: String,
    api: { setupMcp: async () => { connected++; }, snapshot: async () => ({ state: {} }), setMcpStep: async () => ({}) },
  };
  for (const name of ["ContentSurface", "SectionHeading", "SetupRow", "PrimaryButton", "SecondaryButton",
    "NoticeRow", "Icon", "DoctorSummary", "FieldRow", "ZeroRiskModelMenu", "McpMark", "TutorialVideo"]) sandbox[name] = name;
  vm.runInNewContext(js + "\nrenderSetup = SetupSurface; renderMcp = McpSurface;", sandbox);
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children ?? [])] : [];
  for (const language of ["en", "zh-CN", "ja", "ko", "zh-TW", "fr"]) {
    const copy = copyFor(language);
    for (const installed of [false, true]) {
      const snapshot = { state: { browserInteractionMode: "automatic", coreSetupComplete: installed,
        codexSetupComplete: installed, claudeSetupComplete: false,
        codexCatalogVerified: false, codexRestartRequired: true, mcpGuideStep: 1 },
        smokePassed: true, mcpCredentialsConfigured: true };
      const base = { snapshot, copy, devProfile: false, operation: null, updateState() {},
        setError(error) { if (error) throw new Error(error); } };
      const setup = visit(sandbox.renderSetup({ ...base, activateBrowser: async () => {},
        browser: { authenticated: true }, showMcp() {} }));
      assert.equal(setup.find(node => node.type === "SetupRow" && node.props.index === 3).props.complete, installed);
      assert.equal(setup.find(node => node.props.className === "next-surface-row").props.disabled, !installed);
      assert.ok(setup.some(node => node.type === "NoticeRow" && node.children.includes(copy.restartCodex)));
      const mcp = visit(sandbox.renderMcp({ ...base, language, interactionMode: "automatic", onDone() {} }));
      const connect = mcp.find(node => node.type === "PrimaryButton" && node.children.includes(copy.reconnect));
      assert.ok(connect);
      assert.equal(connect.props.disabled, !installed);
      if (installed) await connect.props.onClick();
      assert.equal(snapshot.state.codexCatalogVerified, false, "connecting cannot fabricate catalog verification");
    }
  }
  assert.equal(connected, 6);
});
