import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserDiagnostics } from "../src/adapters/chatgpt-web/browser-diagnostics";
import { effortReadinessHtml } from "./fixtures/effort-readiness";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const efforts = ["low", "medium", "high", "xhigh", "max"];

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("readiness diagnostics distinguish open and editable states without content", async () => {
  const root = mkdtempSync(join(tmpdir(), "effort-readiness-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(effortReadinessHtml());
    const diagnostics = new ChatGptBrowserDiagnostics("effort_readiness_test", root, true);
    await diagnostics.capture(page, "ready");
    await page.locator('button').click();
    await page.locator('#prompt-textarea').evaluate(element => element.setAttribute("contenteditable", "false"));
    await diagnostics.capture(page, "open");
    const directory = join(root, readdirSync(root)[0]!);
    const text = readdirSync(directory).sort().map(file => readFileSync(join(directory, file), "utf8"));
    const [ready, open] = text.map(value => JSON.parse(value).state);
    expect(ready).toMatchObject({ composerEditable: true, effortControlUnique: true, effortControlExpanded: false, effortControlClosed: true });
    expect(open).toMatchObject({ composerEditable: false, effortControlUnique: true, effortControlExpanded: true, effortControlClosed: false });
    expect(text.join("")).not.toMatch(/Draft to preserve|Effort de réflexion|about:blank/);
  } finally {
    await browser.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("effort-readiness-")) throw Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
const positive = [
  ...["fr", "en"].flatMap(language => efforts.map(effort => ({ language, effort, scenario: "delayed-close" }))),
  ...["delayed-editor", "family-readback"].map(scenario => ({ language: "fr", effort: "max", scenario })),
];
for (const { language, effort, scenario } of positive) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`effort readiness: ${language} ${effort} ${scenario}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(effortReadinessHtml(language, scenario));
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const mode = await worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, capabilities, undefined, false, "6");
      await worker.assertSelectedEffort(page, mode);
      expect(await page.locator('button').getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator('#prompt-textarea').isEditable()).toBe(true);
      expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe(String(efforts.indexOf(effort)));
      expect(mode.selection.label).not.toMatch(/effort|réflexion/i);
      expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft to preserve");
    } finally { await browser.close(); }
  }, 20_000);
}

for (const scenario of ["persistent-open", "wrong-effort", "wrong-family", "navigate", "ambiguous"]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`effort readiness rejects ${scenario}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(effortReadinessHtml("fr", scenario));
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const start = Date.now();
      const error = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "max", capabilities, undefined, false, "6")
        .then(() => undefined, (failure: unknown) => failure);
      expect(error).toMatchObject({ retryable: false });
      expect(Date.now() - start).toBeLessThan(7_000);
      expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft to preserve");
    } finally { await browser.close(); }
  }, 15_000);
}
