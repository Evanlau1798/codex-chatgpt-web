const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const jsx = require("react/jsx-runtime");
const read = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");

test("manual instructions are limited to awaiting-user and sent states", () => {
  const app = read("App.tsx");
  const expression = app.match(/\{(manualTab[^\n]*?) \? \(/)[1];
  const visible = new Function("manualTab", `return Boolean(${expression});`);
  for (const state of ["awaiting-user", "sent", "running", "completed", "timed-out", "cancelled", "failed"]) {
    assert.equal(visible({ manualState: state }), ["awaiting-user", "sent"].includes(state), state);
  }
});

test("manual guide follows server deadlines, Sent state and timer cleanup", () => {
  let now = 10_000;
  let state = now;
  let cleanup;
  let previousDeps;
  let tick;
  let timerStarts = 0;
  let timerStops = 0;
  const fakeReact = {
    useState: () => [state, value => { state = value; }],
    useEffect: (effect, deps) => {
      if (JSON.stringify(deps) === JSON.stringify(previousDeps)) return;
      cleanup?.();
      cleanup = effect();
      previousDeps = deps;
    },
  };
  const exportsObject = {};
  new Function("exports", "require", "window", "Date", ts.transpileModule(read("manual-turn-guide.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)(exportsObject, name => name === "react" ? fakeReact : jsx, {
    setInterval: callback => { tick = callback; timerStarts++; return timerStarts; },
    clearInterval: () => { tick = null; timerStops++; },
  }, { now: () => now, parse: Date.parse });
  const copy = Object.fromEntries(["manualPromptTitle", "manualPromptInstruction", "manualPromptWaiting",
    "manualPromptCopy", "manualPromptSent", "manualPromptSeconds"].map(key => [key, key]));
  let copies = 0;
  let confirmations = 0;
  const tab = { id: "manual", manualState: "awaiting-user", manualDeadlineAt: new Date(190_000).toISOString(),
    canCopyPrompt: true, canConfirmSent: true };
  const render = () => exportsObject.ManualTurnGuide({ copy, tab,
    onCopy: () => copies++, onSent: () => confirmations++ });
  let tree = render();
  assert.equal(tree.props.children[1].props.children, "180 manualPromptSeconds");
  const buttons = tree.props.children[2].props.children;
  assert.equal(buttons[0].props.disabled, false);
  assert.equal(buttons[1].props.disabled, false);
  buttons[0].props.onClick(); buttons[1].props.onClick();
  assert.deepEqual([copies, confirmations], [1, 1]);
  tab.manualState = "sent";
  now += 1_001; tick(); tree = render();
  assert.equal(tree.props.children[0].props.children[0].props.children, "manualPromptWaiting");
  assert.equal(tree.props.children[0].props.children[1], null);
  assert.equal(tree.props.children[1].props.children, "179 manualPromptSeconds");
  assert.ok(tree.props.children[2].props.children.every(button => button.props.disabled));
  now = 200_000; tick(); tree = render();
  assert.equal(tree.props.children[1].props.children, "0 manualPromptSeconds");
  tab.manualState = "running";
  assert.equal(render(), null);
  assert.equal(timerStarts, timerStops);
  tab.manualState = "awaiting-user";
  render(); cleanup(); // Unmount also releases the pending deadline timer.
  assert.equal(timerStarts, timerStops);
  tab.manualDeadlineAt = "invalid"; previousDeps = undefined; cleanup = undefined;
  tree = render();
  assert.equal(tree.props.children[1].props.children, "");
  assert.equal(timerStarts, timerStops);
  assert.match(read("App.tsx"), /onCopy=\{\(\) => void api!\.copyManualPrompt\(manualTab\.id\)/);
  assert.match(read("App.tsx"), /onSent=\{\(\) => void api!\.confirmManualSent\(manualTab\.id\)/);
});
