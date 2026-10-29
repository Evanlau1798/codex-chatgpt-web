const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

module.exports = function loadI18nModule() {
  const modules = {};
  const load = file => {
    const exportsObject = {};
    const source = fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
    new Function("exports", "require", ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText)(exportsObject, name => modules[name]);
    return exportsObject;
  };
  for (const name of ["zero-risk-copy", "i18n-ja", "i18n-ko", "i18n-zh-tw", "i18n-fr"]) {
    modules[`./${name}`] = load(`${name}.ts`);
  }
  return load("i18n.ts");
};
