const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(startHidden = true) {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const block = (start, end) => {
    const offset = source.indexOf(start);
    assert.ok(offset >= 0);
    const finish = source.indexOf(end, offset + start.length);
    assert.ok(finish > offset);
    return source.slice(offset, finish);
  };
  const globals = block("let mainWindow = null;", "let browserHost = null;");
  const show = block("function showMainWindow() {", "async function openWebUrl(");
  const closed = block('  window.on("closed", () => {', '  for (const event of ["enter-full-screen"');
  const ready = block('  window.once("ready-to-show", () => {', "  trackWindowState(");
  const context = vm.createContext({
    startHidden, state: { onboardingComplete: true }, windowState: { bounds: {}, maximized: false, fullscreen: false },
  });
  vm.runInContext(`${globals}\n${show}
    globalThis.show = showMainWindow;
    globalThis.attach = window => {
      mainWindow = window;
      ${closed}
      ${ready}
    };
  `, context);
  const window = () => Object.assign(new EventEmitter(), {
    events: [], destroyed: false, minimized: false,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore() { this.minimized = false; this.events.push("restore"); },
    show() { this.events.push("show"); }, focus() { this.events.push("focus"); },
  });
  return { show: context.show, attach: context.attach, window };
}

test("second-instance foreground registration precedes runtime materialization", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const registration = source.indexOf('app.on("second-instance"');
  const materialization = source.indexOf("await waitForPackagedRuntimeSource(");
  assert.ok(registration >= 0 && materialization > registration);
});

test("a foreground request before window creation is replayed when a hidden launcher is ready", () => {
  const state = fixture();
  state.show();
  const window = state.window();
  state.attach(window);
  assert.deepEqual(window.events, []);
  window.emit("ready-to-show");
  assert.deepEqual(window.events, ["show", "focus"]);
});

test("foreground requests wait for readiness and coalesce before restoring a minimized window", () => {
  const state = fixture();
  const window = state.window();
  window.minimized = true;
  state.attach(window);
  state.show();
  state.show();
  assert.deepEqual(window.events, []);
  window.emit("ready-to-show");
  assert.deepEqual(window.events, ["restore", "show", "focus"]);
});

test("closing resets readiness while a hidden launch without a foreground request stays hidden", () => {
  const state = fixture();
  const previous = state.window();
  state.attach(previous);
  previous.emit("ready-to-show");
  assert.deepEqual(previous.events, []);
  previous.destroyed = true;
  previous.emit("closed");
  state.show();
  const next = state.window();
  state.attach(next);
  assert.deepEqual(next.events, []);
  next.emit("ready-to-show");
  assert.deepEqual(next.events, ["show", "focus"]);
});

test("a normal visible launch does not require a foreground request", () => {
  const state = fixture(false);
  const window = state.window();
  state.attach(window);
  window.emit("ready-to-show");
  assert.deepEqual(window.events, ["show"]);
});
