const test = require("node:test");
const assert = require("node:assert/strict");
const { createContext, runInContext } = require("node:vm");
const { createWindow } = require("@mixmark-io/domino");
const { configureChatGptAnnouncementDismissal } = require("../electron/browser-announcements.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

// Reduced from the live Study Mode announcement, including its portal and close owner.
const banner = label => `<div data-testid="modal-beacon"><div role="dialog" data-state="open">
  <button id="dismiss" data-testid="close-button" aria-label="${label}"></button>
  <div>Learn anything, step by step</div><button id="try">Try it now</button>
</div></div>`;

function fixture(html, origin = "https://chatgpt.com") {
  const window = createWindow(`<html><body>${html}</body></html>`);
  const document = window.document;
  const clicked = [];
  let notify, connected = false, observers = 0;
  const context = createContext({
    document, Element: window.Element, location: { origin },
    getComputedStyle: element => ({ visibility: element.style.visibility || "visible" }),
    MutationObserver: class {
      constructor(callback) { notify = callback; observers += 1; }
      observe() { connected = true; }
      disconnect() { connected = false; }
    },
  });
  const prepare = () => {
    for (const element of Array.from(document.querySelectorAll("*"))) {
      element.getClientRects = () => element.closest('[hidden], [style="display:none"]') ? [] : [{}];
      if (element.tagName === "BUTTON") element.addEventListener("click", () => clicked.push(element.id));
    }
  };
  prepare();
  return {
    document, clicked,
    configure: enabled => runInContext(`(${configureChatGptAnnouncementDismissal})(${enabled})`, context),
    mutate: html => {
      document.body.innerHTML = html;
      prepare();
      if (connected) notify([{ target: document.body, addedNodes: Array.from(document.body.childNodes) }]);
    },
    notify: () => {
      if (connected) notify([{ target: document.querySelector('[data-testid="modal-beacon"]'), addedNodes: [] }]);
    },
    observers: () => observers,
  };
}

test("announcement dismissal is scoped to its portal and independent of the Close translation", () => {
  for (const label of ["Close", "关闭", "閉じる", "닫기", "Fechar"]) {
    const f = fixture(`${banner(label)}<div role="dialog"><button id="settings" data-testid="close-button"></button></div>`);
    f.configure(true);
    f.configure(true);
    f.notify();
    assert.deepEqual(f.clicked, ["dismiss"]);
    assert.equal(f.observers(), 1);
  }
});

test("unrelated, hidden, disabled, nested and ambiguous close controls are not activated", () => {
  for (const html of [
    banner("Close").replace('data-testid="modal-beacon"', 'data-testid="settings"'),
    banner("Close").replace('data-state="open"', 'data-state="closed"'),
    banner("Close").replace('data-state="open"', 'data-state="open" hidden'),
    banner("Close").replace('id="dismiss"', 'id="dismiss" disabled'),
    banner("Close").replace('id="dismiss"', 'id="dismiss" aria-disabled="true"'),
    banner("Close").replace('id="dismiss"', 'id="dismiss" style="visibility:hidden"'),
    banner("Close").replace('id="try"', 'id="try" data-testid="close-button"'),
    banner("Close") + banner("Close"),
    '<div data-testid="modal-beacon"><div role="dialog" data-state="open"><div role="dialog"><button id="nested" data-testid="close-button"></button></div></div></div>',
    '<div role="dialog"><button id="quota" data-testid="close-button">Too many requests</button></div>',
  ]) {
    const f = fixture(html);
    f.configure(true);
    assert.deepEqual(f.clicked, []);
  }
  const otherOrigin = fixture(banner("Close"), "https://accounts.google.com");
  otherOrigin.configure(true);
  assert.deepEqual(otherOrigin.clicked, []);
  assert.equal(otherOrigin.observers(), 0);
});

test("late announcements close, while disconnect stops subsequent DOM handling", () => {
  const f = fixture("");
  f.configure(true);
  f.mutate(banner("Close"));
  assert.deepEqual(f.clicked, ["dismiss"]);
  f.configure(false);
  f.mutate(banner("Close"));
  assert.deepEqual(f.clicked, ["dismiss"]);
  f.configure(true);
  assert.deepEqual(f.clicked, ["dismiss", "dismiss"]);
});

test("mode teardown targets only the primary and automatic surfaces", async () => {
  const touched = [];
  const view = id => ({ webContents: {
    isDestroyed: () => false,
    executeJavaScript: async script => { touched.push(id); assert.match(script, /\)\(false\)$/); },
  } });
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    view: view("home"),
    turnTabs: new Map([
      ["auto", { interactionMode: "automatic", view: view("auto") }],
      ["manual", { interactionMode: "manual", view: view("manual") }],
    ]),
  });
  await host.configureAnnouncementDismissal(false);
  assert.deepEqual(touched, ["home", "auto"]);
});
