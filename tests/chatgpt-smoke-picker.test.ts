import { launchDomBrowser } from "./support/dom-browser";
import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { ChatGptBrowserWorker } from '../src/adapters/chatgpt-web/browser-worker';
import { CHATGPT_COMPOSER_SELECTOR } from '../src/chatgpt-session';
// Sliderless-picker reproduction and initial regression cases contributed in #876.
for (const scenario of ["immediate", "delayed", "missing-family", "cancelled-slider"])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`smoke handles a sliderless default picker (${scenario})`, async () => {
  const browser = await launchDomBrowser();
  try {
    const page = await browser.newPage();
    const abort = new AbortController();
    await page.exposeFunction("cancelSmoke", () => abort.abort());
    await page.setContent(`<form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Draft</div>
      <button type="button" ${scenario === "delayed" ? "hidden" : ""} data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"
        aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Medium</button></form>
      <div id="picker" role="menu" hidden><div data-model-picker-view="advanced">
        <div role="menuitemradio" aria-checked="true">6</div>
        <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>
        <div id="effort"></div>
      </div></div><script>
        const control=document.querySelector('button'),menu=document.querySelector('#picker');
        const view=document.querySelector('[data-model-picker-view]');
        if (${scenario === "delayed"}) setTimeout(()=>{control.hidden=false;},300);
        control.onclick=()=>{menu.hidden=false;control.setAttribute('aria-expanded','true');};
        document.querySelectorAll('[role=menuitemradio]')[1].onclick=()=>{
          document.querySelectorAll('[role=menuitemradio]').forEach((el,i)=>el.setAttribute('aria-checked',String(i===1)));
          view.setAttribute('data-model-picker-view','simple');
          if (${scenario === "cancelled-slider"}) {setTimeout(()=>window.cancelSmoke(),100);return;}
          document.querySelector('#effort').innerHTML='<span id="status" role="status">5.6 Sol High, 3 of 5.</span>'
            +'<div role="menuitem" tabindex="0" aria-describedby="status">'
            +'<div data-model-picker-power-slider style="height:30px;width:250px">'
            +'<span data-orientation="horizontal" aria-disabled="false">'
            +Array.from({length:5},(_,i)=>'<span data-selected="'+(i<=2)+'"></span>').join('')
            +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span></span></div></div>';
          control.textContent='5.6 Sol High';
        };
        if (${scenario === "missing-family"}) document.querySelectorAll('[role=menuitemradio]')[1].remove();
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');}});
      </script>`);
    expect(await page.locator('[role=slider]').count()).toBe(0);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { useSavedChats: false };
    worker.ensurePage = async () => page;
    worker.prepareChatSurface = async () => {};
    worker.activeComposer = async () => page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    let turns = 0;
    worker.runBrowserTurn = async (options: any) => {
      turns += 1;
      expect(options.modelFamily).toBe("5.6");
      expect(options.reasoning).toBe("high");
      expect(options.capabilities).toEqual({
        solAvailable: true, extraHighAvailable: true, proAvailable: true, localToolsEnabled: false,
      });
      expect(await page.locator('[role=menuitemradio][aria-checked=true]').textContent()).toBe("GPT-5.6 Sol");
      expect(await page.locator('#picker').isVisible()).toBe(false);
      return "CODEX WEB GPT READY";
    };
    if (scenario === "missing-family" || scenario === "cancelled-slider") {
      const failure = await worker.smokeTestExclusive(abort.signal)
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject(scenario === "missing-family"
        ? { code: "model_version_unavailable", retryable: false }
        : { name: "AbortError" });
      expect(turns).toBe(0);
      expect(await page.locator('#picker').isVisible()).toBe(false);
      expect(await page.getByRole('textbox').innerText()).toBe('Draft');
    } else {
      expect(await worker.smokeTestExclusive(abort.signal)).toMatchObject({ response: "CODEX WEB GPT READY" });
      expect(turns).toBe(1);
    }
  } finally { await browser.close(); }
}, 15_000);

// Luna requires positive Think evidence; keep the real probe's full hydration budget.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("smoke uses Luna when the composer has a verified Think control", async () => {
  const browser = await launchDomBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Draft</div>
      <button type="button" aria-pressed="false">Think</button>
    </form>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { useSavedChats: false };
    worker.ensurePage = async () => page;
    worker.prepareChatSurface = async () => {};
    worker.activeComposer = async () => page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    let turns = 0;
    worker.runBrowserTurn = async (options: any) => {
      turns += 1;
      expect(options.modelFamily).toBeUndefined();
      expect(options.reasoning).toBe("low");
      expect(options.capabilities).toEqual({
        solAvailable: false, extraHighAvailable: false, proAvailable: false, localToolsEnabled: false,
      });
      return "CODEX WEB GPT READY";
    };
    expect(await worker.smokeTestExclusive()).toMatchObject({ response: "CODEX WEB GPT READY" });
    expect(turns).toBe(1);
  } finally { await browser.close(); }
}, 40_000);
