const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const read = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
const exportsObject = {};
new Function("exports", ts.transpileModule(read("zero-risk-copy.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(exportsObject);
const dictionaries = exportsObject.zeroRiskCopy;
const app = read("App.tsx");

test("manual MCP setup explains separate credentials and local-only verification in every locale", () => {
  for (const copy of Object.values(dictionaries)) {
    assert.ok(copy.manualMcpStepThreeBody?.length > 30);
    assert.ok(copy.manualConnectorNotice?.length > 30);
    assert.ok(!copy.manualConnectorNotice.includes("Codex Native2"));
  }
  assert.match(dictionaries.en.manualMcpStepThreeBody, /every turn/);
  assert.match(dictionaries.en.manualConnectorNotice, /separate.*tunnel.*credentials/i);
  assert.match(dictionaries.en.manualConnectorNotice, /local runtime.*not.*ChatGPT/i);
  assert.match(app, /manualInteraction \? copy\.manualMcpStepThreeBody : copy\.mcpStepThreeBody/);
  assert.match(app, /manualInteraction \? copy\.manualConnectorNotice : devProfile \? copy\.devConnectorIsolationNotice : copy\.connectorMigrationNotice/);
  assert.match(app, /snapshot\.connectorNames\[interactionMode\]/);
});

test("all locales disclose Pro selection prerequisites and automation policy risk", () => {
  for (const [language, terms] of Object.entries({
    en: [/Pro account/, /every turn/, /effort/, /cannot verify/, /terms.*account polic/],
    "zh-CN": [/Pro 帳戶/, /每回合/, /effort/, /無法驗證/, /條款.*帳戶政策/],
    ja: [/Pro アカウント/, /毎ターン/, /effort/, /検証できません/, /規約.*アカウントポリシー/],
  })) {
    const copy = dictionaries[language];
    for (const term of terms.slice(0, -1)) assert.match(copy.zeroRiskModelSettingsBody, term);
    assert.match(copy.automaticInteractionBody, terms.at(-1));
  }
  assert.match(app, /SettingRow body=\{copy\.zeroRiskModelSettingsBody\}/);
  assert.match(read("interaction-mode-picker.tsx"), /<small>\{value === "automatic" \? copy\.automaticInteractionBody : copy\.manualInteractionBody\}/);
});
