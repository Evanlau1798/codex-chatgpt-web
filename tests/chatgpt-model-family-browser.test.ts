// Reproduction contributed by @alexalok in PR #730.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { readChatGptUsageModel } from "../src/adapters/chatgpt-web/limits";

let browser: Browser;
beforeAll(async () => {
  if (process.env.CHATGPT_DOM_TEST_BROWSER) browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); });

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
  current: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  legacy: { header: null, status: (effort: string, value: number) => (value === 4 ? "6 " : "5.6 ") + effort + ", " + (value + 1) + " of 5." },
  future: { header: (value: number) => value === 4 ? "7" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionless: { header: () => "", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  conflicting: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => (value === 4 ? "5.6 " : "") + effort + ", " + (value + 1) + " of 5." },
} satisfies Record<string, Picker>;

const FIXTURE = `<form><div id="prompt-textarea" contenteditable="true">Draft</div>
  <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Medium</button></form>
  <div id="picker" role="menu" aria-label="Select ChatGPT model" hidden>
    <div data-model-picker-view="simple">
      <div aria-hidden="false" data-active="true">
        <div data-explicit-model="false">
          <div role="menuitem" aria-hidden="false" aria-label="Select model" data-model-picker-view-toggle="true" tabindex="0">
            <div data-menu-row-content="true"><span><span><span id="header-version"></span><span id="header-effort" data-accent="true"></span><svg></svg></span></span></div>
          </div>
          <span aria-hidden="true"><span>Consumes usage limits faster</span></span>
        </div>
        <span aria-live="polite" id="status" role="status"></span>
        <span id="hint">Use Left and Right arrow keys to adjust power</span>
        <div role="menuitem" aria-describedby="status hint" aria-label="Power" data-reasoning-slider="true" tabindex="-1">
          <div data-menu-row-content="true"><span><div data-model-picker-power-slider style="height:30px;width:250px"></div></span></div>
        </div>
      </div>
      <div aria-hidden="true" data-active="false" inert>
        <span>Locked, opens access options</span>
        <div role="menuitemradio" aria-checked="true" data-model-selected="true" tabindex="-1"><div data-menu-row-content="true"><span>Latest</span></div></div>
        <div role="menuitemradio" aria-checked="false" tabindex="-1"><div data-menu-row-content="true"><span>GPT-5.6 Sol</span></div></div>
        <div role="menuitemradio" aria-checked="false" tabindex="-1"><div data-menu-row-content="true"><div><span>GPT-5.5</span><span>Leaving on October 14</span></div></div></div>
      </div>
    </div>
  </div>
  <script>
    const efforts = ["Instant", "Medium", "High", "Extra High", "Pro"];
    const control = document.querySelector("button"), menu = document.querySelector("#picker");
    let value = 1;
    function render() {
      document.querySelector("[data-model-picker-power-slider]").innerHTML = '<span data-orientation="horizontal" aria-disabled="false">'
        + efforts.map((_, i) => '<span data-selected="' + (i <= value) + '"></span>').join("")
        + '<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' + value + '"></span></span>';
      document.querySelector("#status").textContent = window.pickerStatus(efforts[value], value);
      if (window.pickerHeader === null) document.querySelector("[data-model-picker-view-toggle]")?.remove();
      else {
        document.querySelector("#header-version").textContent = window.pickerHeader(value);
        document.querySelector("#header-effort").textContent = efforts[value];
      }
    }
    control.onclick = () => {
      menu.hidden = false; control.setAttribute("aria-expanded", "true"); control.textContent = "Thinking effort"; render();
    };
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        menu.hidden = true; control.setAttribute("aria-expanded", "false"); control.textContent = efforts[value];
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        value = Math.max(0, Math.min(4, value + (event.key === "ArrowRight" ? 1 : -1))); render(); event.preventDefault();
      }
    });
  </script>`;

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
  const picker = { header: () => "6", status: PICKERS.current.status };
  const result = await selectGpt6Pro(picker, effort, "6");
  expect(result.ok).toBe(true);
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("renamed 6 picker accepts the visible Pro-only header using its versioned Chinese announcement", async () => {
  const picker = { header: () => "", status: (effort: string, value: number) => `6 ${effort}，第 ${value + 1} 個，共 5 個。` };
  expect(await selectGpt6Pro(picker, "max", "6")).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("explicit GPT-6 rejects stale 5.6 effort evidence without sending the draft", async () => {
  const result = await selectGpt6Pro(PICKERS.current, "high", "GPT-6");
  expect(result.ok).toBe(false);
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is verified from the current picker header when the slider announces only the effort", async () => {
  expect(await selectGpt6Pro(PICKERS.current)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is still verified from the older versioned slider announcement", async () => {
  expect(await selectGpt6Pro(PICKERS.legacy)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
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
