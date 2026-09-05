import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("effort selection uses structural menu and slider indices instead of localized labels", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("mode.uiEffortIndex");
  expect(workerSource).toContain("CHATGPT_EFFORT_MENU_SELECTOR");
  expect(workerSource).toContain("CHATGPT_EFFORT_ITEM_SELECTOR");
  expect(sessionSource).toContain('[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])');
  expect(sessionSource).toContain('[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])');
  expect(sessionSource).toContain('[role="menuitemradio"]');
  expect(sessionSource).toContain('[data-model-reasoning-effort-slider] [role="slider"]');
  expect(sessionSource).not.toContain(":popover-open");
  expect(sessionSource).not.toContain("data-radix-collection-item");
  expect(workerSource).toContain('sliderContainer.waitFor({ state: "visible"');
  expect(workerSource).toContain('effortSlider.waitFor({ state: "attached"');
  expect(workerSource).toContain('getAttribute("aria-valuenow")');
  expect(workerSource).toContain("sliderControl.press(key)");
  expect(workerSource).not.toContain("currentLabel === targetLabel");
  expect(workerSource).not.toContain("chatGptEffortLabelsMatch");
  expect(workerSource).not.toMatch(/getByRole\("button", \{\s*name: "(?:Instant|Medium|High|Extra High|Pro)"/);
});


test("effort selection handles the known ChatGPT rate-limit dialog before menu activation", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const selectionStart = workerSource.indexOf("private async selectModelAndEffort");
  const selectionEnd = workerSource.indexOf("private async activeComposer", selectionStart);
  const selectionSource = workerSource.slice(selectionStart, selectionEnd);
  const guard = selectionSource.indexOf("throwIfChatGptRateLimitDialog(page)");
  const activation = selectionSource.indexOf("activateChatGptEffortMenu(page, currentEffort)");

  expect(workerSource).toContain("Too many requests");
  expect(workerSource).toContain("making requests too quickly");
  expect(guard).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(guard);
  expect(selectionSource).not.toContain('currentEffort.press("Enter")');
  expect(selectionSource).toContain('sliderControl.press(key)');
  expect(selectionSource).not.toContain("effortChoice.click(");
  expect(selectionSource).not.toContain("is unavailable");
});


test("the daemon prefers the browser helper that shipped beside its own entrypoint", () => {
  const client = readFileSync("src/adapters/chatgpt-web/launcher-helper-client.ts", "utf8");
  const processHelper = readFileSync("src/adapters/chatgpt-web/launcher-helper-process.ts", "utf8");
  const helper = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");
  const fence = readFileSync("src/adapters/chatgpt-web/browser-helper-fence.ts", "utf8");

  // The launcher advertises the helper inside its signed application bundle while the daemon runs
  // from a versioned runtime directory, so the two update independently. A daemon that spoke a
  // newer protocol to an older helper had its frame routed to the run handler, which dereferenced
  // a turn the frame never carried and destroyed the turn with an opaque TypeError.
  expect(client).toContain("resolveLauncherHelperScript(");
  expect(processHelper).toContain('basename(entrypoint) === "cli.js"');
  expect(processHelper).toContain('join(dirname(entrypoint), "browser-helper.cjs")');

  // Belt and braces: negotiate the frame, and never treat an unrecognised frame as a run.
  expect(client).toContain('this.helperFeatures.has("progress")');
  expect(helper).toContain('features: ["progress", "tool-boundary-ack", "completion-fence", "multipart-stage-ack"]');
  expect(helper).toMatch(/message\.type === "run"/);
  expect(helper).toContain("Browser helper received an unsupported message type");

  // A malformed liveness hint must not destroy an accepted turn that can never be resent.
  expect(fence).toContain("discarded an invalid MCP progress frame");
});
