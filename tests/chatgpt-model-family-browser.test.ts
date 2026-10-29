// Reproduction contributed by @alexalok in PR #730.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { readChatGptUsageModel } from "../src/adapters/chatgpt-web/limits";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";

let browser: Browser;
beforeAll(async () => {
  if (process.env.CHATGPT_DOM_TEST_BROWSER) browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); });

// October 28 picker: Default mixes model families; explicit Sol has five
// positions and explicit Astra has six. Never infer a family from Default.
const EXPLICIT_PICKER = readFileSync(new URL("./fixtures/chatgpt-model-picker-explicit-2026-10-28.html", import.meta.url), "utf8");

for (const selected of ["Default Recommended set of models", "GPT-6 Astra"]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`capability probing preserves ${selected} while proving named model rows`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(EXPLICIT_PICKER);
      await page.locator("button").click();
      if (selected === "GPT-6 Astra") {
        await page.locator('[data-model-picker-view-toggle="true"]').click();
        await page.getByRole("menuitemradio", { name: selected, exact: true }).click();
      }
      const before = await page.locator('[role="slider"]').getAttribute("aria-valuenow");
      const capabilities = await detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 1_000 });
      expect(capabilities.modelCapabilities?.families["6"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(capabilities.proAvailable).toBeTrue();
      expect(await page.getByRole("menuitemradio", { name: selected, exact: true, includeHidden: true }).getAttribute("aria-checked")).toBe("true");
      expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe(before);
      expect(await page.locator("#prompt-textarea").innerText()).toBe("Draft");
    } finally { await page.close(); }
  }, 30_000);
}

for (const [effort, label, usageModel] of [["high", "6 Sol High", "other"], ["xhigh", "6 Sol Extra High", "other"], ["max", "6 Astra Max", "gpt-6-pro"]] as const) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`explicit picker selects exact GPT-6 ${effort} beside GPT-6.1`, async () => {
    const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
    try {
      const page=await browser.newPage();await page.setContent(EXPLICIT_PICKER);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
      const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,effort,{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,true,"6");
      expect(mode.selection.label).toBe(label);expect(mode.usageModel).toBe(usageModel);
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Draft');
    } finally {await browser.close();}
  },30_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("explicit picker refuses absent GPT-6 Sol and conflicting GPT-6.1 evidence",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    for(const scenario of ['omitSol','conflictingHeader']){
      const page=await browser.newPage();await page.setContent('<script>window.'+scenario+'=true;</script>'+EXPLICIT_PICKER);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
      let failure: unknown;
      try {
        await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,'high',{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,false,'6');
      } catch (error) { failure=error; }
      expect(String(failure)).toContain('could not be selected and verified');
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Draft');await page.close();
    }
  }finally{await browser.close();}
},30_000);

// Mirrors ChatGPT's power picker as captured live on 2026-09-29 (English, Pro account): the slider
// announcement reads only "Pro, 5 of 5." and the model version appears in the "Select model"
// header as <span>6</span><span data-maximum>Pro</span>. Older pickers announced "6 Pro, 5 of 5.".
type Picker = {
  /** Header version per slider value; null removes the header like older pickers. */
  header: ((value: number) => string) | null;
  /** Slider announcement per effort label and slider value. */
  status: (effort: string, value: number) => string;
};

const PICKERS = {
  splitHeader: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionedAnnouncement: { header: null, status: (effort: string, value: number) => (value === 4 ? "6 " : "5.6 ") + effort + ", " + (value + 1) + " of 5." },
  future: { header: (value: number) => value === 4 ? "7" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionless: { header: () => "", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  conflicting: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => (value === 4 ? "5.6 " : "") + effort + ", " + (value + 1) + " of 5." },
} satisfies Record<string, Picker>;

const FIXTURE = readFileSync(new URL("./fixtures/chatgpt-model-picker-power-2026-09-29.html", import.meta.url), "utf8");

async function selectGpt6Pro(picker: Picker, effort: "low" | "medium" | "high" | "xhigh" | "max" = "max", familyLabel = "Latest") {
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(5_000);
    const config = "<script>window.pickerHeader = " + (picker.header ? picker.header.toString() : "null")
      + "; window.pickerStatus = (_effort, value) => "
      + JSON.stringify(["Instant", "Medium", "High", "Extra High", "Pro"].map((effort, value) => picker.status(effort, value)))
      + "[value];</script>";
    await page.setContent(config + FIXTURE);
    await page.getByRole("menuitemradio", { name: "Latest", exact: true, includeHidden: true }).evaluate((element, label) => { element.textContent = label; }, familyLabel);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    try {
      const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, effort, {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      }, undefined, true, "6");
      return { ok: true, label: mode.selection.label, usageModel: mode.usageModel, draft: await page.locator("#prompt-textarea").innerText() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), draft: await page.locator("#prompt-textarea").innerText() };
    }
  } finally {
    await page.close();
  }
}

for (const effort of ["low", "medium", "high", "xhigh", "max"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`renamed 6 picker verifies ${effort} through the production worker`, async () => {
  const picker = { header: () => "6", status: PICKERS.splitHeader.status };
  const result = await selectGpt6Pro(picker, effort, "6");
  expect(result.ok).toBe(true);
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("renamed 6 picker accepts the visible Pro-only header using its versioned Chinese announcement", async () => {
  const picker = { header: () => "", status: (effort: string, value: number) => `6 ${effort}，第 ${value + 1} 個，共 5 個。` };
  expect(await selectGpt6Pro(picker, "max", "6")).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("explicit GPT-6 rejects stale 5.6 effort evidence without sending the draft", async () => {
  const result = await selectGpt6Pro(PICKERS.splitHeader, "high", "GPT-6");
  expect(result.ok).toBe(false);
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is verified from the current picker header when the slider announces only the effort", async () => {
  expect(await selectGpt6Pro(PICKERS.splitHeader)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is still verified from the versioned slider announcement", async () => {
  expect(await selectGpt6Pro(PICKERS.versionedAnnouncement)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

for (const scenario of ["future", "versionless", "conflicting"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro fails closed when the picker's model evidence is " + scenario, async () => {
  const result = await selectGpt6Pro(PICKERS[scenario]);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("ChatGPT model 6 could not be selected and verified");
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("model evidence excludes inactive and foreign picker headers and rejects multiple active headers", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="menu" id="owned">
      <div data-model-picker-view-toggle="true" id="active"><div data-menu-row-content>
        <span>6</span><span>Pro</span><span hidden>5.6</span>
      </div></div>
      <div role="menuitem" aria-describedby="status"><span role="slider"></span></div>
      <span id="status">Pro, 5 of 5.</span>
      <div hidden><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div inert><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div aria-hidden="true"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div style="display:none"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div role="menu"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
    </div><div role="menu"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>`);
    const slider = page.getByRole("slider");
    expect(await readChatGptUsageModel(slider, true)).toBe("gpt-6-pro");
    await page.locator("#active").evaluate(element => element.setAttribute("hidden", ""));
    expect(await readChatGptUsageModel(slider, true)).toBe("pro-unknown");
    await page.locator("#active").evaluate(element => {
      element.removeAttribute("hidden");
      element.after(element.cloneNode(true));
    });
    await expect(readChatGptUsageModel(slider, true)).rejects.toThrow("multiple active model headers");
  } finally {
    await page.close();
  }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("localized position punctuation works through actual picker selection and usage readback", async () => {
  for (const separator of ["、", "،", "；", "—"]) {
    const picker: Picker = { header: null, status: (effort, value) => `${value === 4 ? "6" : "5.6"} ${effort}${separator}5 件中 ${value + 1} 番目。` };
    expect(await selectGpt6Pro(picker)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
  }
}, 60_000);
