import { launchDomBrowser } from "./support/dom-browser";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";
import { ChatGptBrowserWorker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";

const browserPath = process.env.CHATGPT_DOM_TEST_BROWSER;
const probe = { selectorTimeoutMs: 150, stableAbsenceMs: 0 };

test.skipIf(!browserPath)("setup reads the October inline control on paid accounts and rejects stale Luna selection (#932)", async () => {
  const browser = await launchDomBrowser(browserPath);
  try {
    for (const paidRange of [3, 5]) {
      const page = await browser.newPage();
      let html = readFileSync(new URL('./fixtures/chatgpt-model-picker-power-2026-09-29.html', import.meta.url), 'utf8')
        .replace('data-tone="neutral"', 'data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium" aria-label="选择 ChatGPT 模型"');
      if (paidRange === 3) html = html.replace('["Instant", "Medium", "High", "Extra High", "Pro"]', '["Instant", "Medium", "High"]')
        .replaceAll('aria-valuemax="4"', 'aria-valuemax="2"').replace('Math.min(4,', 'Math.min(2,');
      await page.setContent('<script>window.pickerHeader=()=>"6";window.pickerStatus=(effort,value)=>`6 ${effort}, ${value+1}.`;</script>' + html);
      // Enhanced inspection probes each family and restores it; the dated slider-only
      // fixture needs the real model-row transition, not a forced click through an overlay.
      await page.addScriptTag({ content: `
        const view=document.querySelector('[data-model-picker-view]');
        const simple=view.children[0], advanced=view.children[1];
        const rows=[...advanced.querySelectorAll('[role=menuitemradio]')];
        let family='6'; advanced.hidden=true;
        window.pickerHeader=()=>family;
        window.pickerStatus=(effort,value)=>family+' '+effort+', '+(value+1)+'.';
        document.querySelector('[data-model-picker-view-toggle]').onclick=()=>{
          simple.hidden=true;advanced.hidden=false;advanced.inert=false;
          advanced.setAttribute('aria-hidden','false');view.setAttribute('data-model-picker-view','advanced');
        };
        rows.forEach((row,index)=>row.onclick=()=>{
          family=index===0?'6':index===1?'5.6':'5.5';
          rows.forEach((r,i)=>r.setAttribute('aria-checked',String(i===index)));
          simple.hidden=false;advanced.hidden=true;advanced.inert=true;
          advanced.setAttribute('aria-hidden','true');view.setAttribute('data-model-picker-view','simple');render();
        });
      ` });
      const composer = page.locator('#prompt-textarea');
      const draft = await composer.innerHTML();
      // This is the setup/reinstall reader, not just normal turn selection.
      expect(await detectChatGptAccountCapabilities(page, probe)).toEqual({
        solAvailable: true, extraHighAvailable: paidRange === 5, proAvailable: paidRange === 5,
        modelCapabilities: { observedAt: expect.any(Number), families: {
          "6": paidRange === 5 ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"],
          "5.6": paidRange === 5 ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"],
        } },
      });
      expect(await page.locator('#picker').isVisible()).toBeFalse();
      expect(await composer.innerHTML()).toBe(draft);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      for (const reasoning of ['low', 'medium']) {
        await expect(worker.selectModelAndEffort(page, 'gpt-5.6-luna', reasoning,
          { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false }))
          .rejects.toMatchObject({ code: 'chatgpt_capabilities_stale', retryable: false });
      }
      expect(await composer.innerHTML()).toBe(draft);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!browserPath)("only a unique recognized Think control proves a Luna account, without clicking or submitting", async () => {
  const browser = await launchDomBrowser(browserPath);
  try {
    const page = await browser.newPage();
    const think = readFileSync(new URL('./fixtures/chatgpt-composer-think-2026-10-28.html', import.meta.url), 'utf8');
    for (const controls of [think, '<button type="button" aria-pressed="true">Think</button>']) {
      await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Keep my draft</div>${controls}</form>`);
      const before = await page.locator('form').innerHTML();
      const detected = await detectChatGptAccountCapabilities(page, probe);
      expect(detected).toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false,
        modelCapabilities: { observedAt: expect.any(Number), families: {} } });
      expect(await page.locator('form').innerHTML()).toBe(before);
    }
    for (const controls of [
      '', '<button aria-haspopup="menu" data-composer-navigation-target="reasoning">6 High</button>',
      '<button type="button" aria-pressed="false" hidden>Think</button>',
      '<button type="button">Think</button>',
      '<button type="button" aria-pressed="false">Think harder</button>',
      '<button type="button" aria-pressed="false">Think</button><button type="button" aria-pressed="true">Think</button>',
    ]) {
      await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Keep my draft</div>${controls}</form>
        <button type="button" aria-pressed="false">Think</button>`);
      await expect(detectChatGptAccountCapabilities(page, probe)).rejects.toThrow("Could not identify ChatGPT's model controls");
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Keep my draft');
    }
    await page.setContent('<form><div id="prompt-textarea" contenteditable="true">Keep my draft</div></form>');
    await expect(setChatGptThinkMode(page.locator('#prompt-textarea'), false))
      .rejects.toMatchObject({ code: 'chatgpt_model_controls_unavailable', retryable: false });
    expect(await page.locator('#prompt-textarea').innerText()).toBe('Keep my draft');
  } finally { await browser.close(); }
}, 60_000);
