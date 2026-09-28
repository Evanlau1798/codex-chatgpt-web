import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";

for (const modern of [false, true])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`model selection reuses the ${modern ? "power" : "classic"} picker without racing Escape cleanup`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2_000);
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Extra High</button></form>
      <div id="picker" role="menu" hidden><div ${modern ? 'data-model-picker-view="simple"' : ''}>
        <div id="toggle" role="menuitem" aria-hidden="false" aria-expanded="false" data-model-picker-view-toggle="true">Select model</div>
        <div id="models" hidden><div role="menuitemradio" aria-checked="true">Latest</div>
          <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
        <span id="announcement">5.6 Extra High, 4 of 4.</span>
        <div role="menuitem" tabindex="0" aria-describedby="announcement">
          <div data-model-picker-power-slider style="height:30px;width:250px"><span data-orientation="horizontal" aria-disabled="false">
            ${Array(4).fill('<span data-selected="true"></span>').join('')}
            <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="3" aria-valuenow="3"></span>
          </span></div></div>
      </div></div>
      <script>
        const control=document.querySelector('button'),menu=document.querySelector('#picker'),toggle=document.querySelector('#toggle');
        let selected=false;
        window.pickerOpens=0;
        function close(){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=selected?'5.6 Sol Extra High':'Extra High';}
        control.onclick=()=>{window.pickerOpens++;menu.hidden=false;control.setAttribute('aria-expanded','true');};
        toggle.onclick=()=>{document.querySelector('#models').hidden=false;toggle.setAttribute('aria-expanded','true');};
        document.querySelectorAll('[role=menuitemradio]')[1].onclick=()=>{
          selected=true;
          document.querySelectorAll('[role=menuitemradio]').forEach((e,i)=>e.setAttribute('aria-checked',String(i===1)));
          document.querySelector('#models').hidden=true;
        };
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){close();setTimeout(close,150);}});
      </script>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const result = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "xhigh", {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, undefined, false, "5.6");
    expect(result.selection.label).toBe("5.6 Sol Extra High");
    expect(await page.evaluate(() => (window as any).pickerOpens)).toBe(2);
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 30_000);

for (const scenario of ["hydrate", "shrink", "locked", "pro-disappears"])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`real slider ${scenario} keeps the requested available effort`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Instant</button></form>
      <div id="picker" role="menu" hidden><div role="menuitem" tabindex="0"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div></div>
      <script>
        let value=0, max=4, opens=0;
        const scenario=${JSON.stringify(scenario)}, control=document.querySelector('button'), menu=document.querySelector('#picker');
        function render(ticks=max+1) {
          document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
            +Array.from({length:ticks},(_,i)=>'<span data-selected="'+(i<=value)+'"'+(scenario==='locked'&&opens>1&&i===2?' data-locked="true"':'')+'></span>').join('')
            +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+max+'" aria-valuenow="'+value+'"></span></span>';
        }
        control.onclick=()=>{
          opens++; menu.hidden=false; control.setAttribute('aria-expanded','true');
          if(opens>1&&(scenario==='shrink'||scenario==='pro-disappears'))max=3;
          value=Math.min(value,max); render(scenario==='hydrate'&&opens===1?4:max+1);
          if(scenario==='hydrate'&&opens===1)setTimeout(()=>{max=3;render()},100);
        };
        document.addEventListener('keydown',e=>{
          if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=['Instant','Medium','High','Extra High','Pro'][value];}
          else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){value+=e.key==='ArrowRight'?1:-1;render();e.preventDefault();}
        });
        render();
      </script>`);
    if (scenario === "hydrate") {
      expect(await detectChatGptAccountCapabilities(page)).toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
    } else {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const effort = scenario === "pro-disappears" ? "max" : scenario === "locked" ? "high" : "xhigh";
      const result = worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      });
      if (scenario === "shrink") expect((await result).selection.label).toBe("Extra High");
      else await expect(result).rejects.toMatchObject({ retryable: false });
    }
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft");
    await page.close();
  } finally { await browser.close(); }
}, 120_000);
