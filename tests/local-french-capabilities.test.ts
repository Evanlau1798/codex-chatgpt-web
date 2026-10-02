import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";
import { availableChatGptWebModelRoutes, chatGptWebRouteEfforts, requireChatGptWebModelRoute, parseChatGptWebModelCapabilities } from "../src/chatgpt-web-models";
import { assertChatGptModelFamily, chatGptUnversionedEffortMatches } from "../src/adapters/chatgpt-web/model-selection";
import { activateChatGptEffortMenu } from "../src/chatgpt-session";
import { launcherCapabilityProbeRequired } from "../src/setup-config";

const evidence = { observedAt: Date.now(), families: {
  "5.6": ["low", "medium", "high", "xhigh", "max"] as const,
  "6": ["low", "medium", "high", "xhigh"] as const,
} };
const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true, modelCapabilities: evidence };

test("per-family catalog exposes 5.6 Pro without enabling unavailable Latest Pro", () => {
  const routes = availableChatGptWebModelRoutes(capabilities);
  expect(routes.some(r => r.slug === "chatgpt-web/gpt-5.6-pro")).toBe(true);
  expect(routes.some(r => r.slug === "chatgpt-web/gpt-6-pro")).toBe(false);
  expect(routes.filter(r => r.interactionMode === "automatic" && r.modelFamily === "5.6")
    .flatMap(r => chatGptWebRouteEfforts(r, capabilities))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(routes.filter(r => r.interactionMode === "automatic" && r.modelFamily === "6")
    .flatMap(r => chatGptWebRouteEfforts(r, capabilities))).toEqual(["low", "medium", "high", "xhigh"]);
  expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-6-pro", capabilities)).toThrow("not available");
  expect(requireChatGptWebModelRoute("chatgpt-web/gpt-5.6-pro", capabilities).adapterEffort).toBe("max");
  const restored = { ...capabilities, modelCapabilities: { ...evidence, families: { ...evidence.families, "6": evidence.families["5.6"] } } };
  expect(availableChatGptWebModelRoutes(restored).some(r => r.slug === "chatgpt-web/gpt-6-pro")).toBe(true);
});

test("capability refresh migrates old observations and rechecks quotas at setup without probing manual mode", () => {
  const config = { ...capabilities, browserHost: "launcher", browserInteractionMode: "automatic" } as any;
  expect(launcherCapabilityProbeRequired(config)).toBe(false);
  expect(launcherCapabilityProbeRequired({ ...config, modelCapabilities: undefined })).toBe(true);
  expect(launcherCapabilityProbeRequired({ ...config, modelCapabilities: { ...evidence, observedAt: Date.now() - 31 * 60_000 } })).toBe(true);
  expect(launcherCapabilityProbeRequired(config, true, "manual")).toBe(false);
  expect(() => parseChatGptWebModelCapabilities({ ...evidence, families: { "6": ["invented"] } })).toThrow();
});

test("unversioned French descriptions require the exact effort and position", () => {
  for (const [effort, status] of [["low", "Instantané, 1 sur 4."], ["medium", "Moyen, 2 sur 4."],
    ["high", "Élevée, 3 sur 4."], ["xhigh", "Très élevé, 4 sur 4."], ["max", "Pro, 5 sur 5."]] as const) {
    expect(chatGptUnversionedEffortMatches([status, "Utilisez les touches fléchées gauche et droite pour régler la puissance"], effort)).toBe(true);
  }
  for (const text of ["Pro", "Essayez Pro", "Pro, 4 sur 5.", "Pro, 5 sur 4.", "7 Pro, 5 sur 5."]) {
    expect(chatGptUnversionedEffortMatches([text], "max")).toBe(false);
  }
});

// Reproduces the current French picker without opening an account or sending messages.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("French picker: per-family probing, selection verification and restoration", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Brouillon à conserver</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">5.6 Pro</button></form>
      <div id="picker" role="menu" hidden><div data-model-picker-view="simple">
      <div role="menuitem" data-model-picker-view-toggle="true" aria-hidden="false" tabindex="0">Sélectionner le modèle</div>
      <div id="power" role="menuitem" aria-describedby="status hint" tabindex="0"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div>
      <div id="radios"><div role="menuitemradio" data-family="6">Le plus récent</div><div role="menuitemradio" data-family="5.6">GPT-5.6 Sol</div></div>
      <span id="status"></span><span id="hint">Utilisez les touches fléchées gauche et droite pour régler la puissance</span></div></div>
      <script>
      let family='5.6', value=4; const control=document.querySelector('button'),menu=document.querySelector('#picker'),view=document.querySelector('[data-model-picker-view]');
      function render(){const max=family==='5.6'?4:3,advanced=view.dataset.modelPickerView==='advanced';
        document.querySelector('#radios').style.display=advanced?'block':'none';
        document.querySelector('#power').style.display=advanced?'none':'block';
        for(const radio of document.querySelectorAll('[data-family]'))radio.setAttribute('aria-checked',String(radio.dataset.family===family));
        document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'+Array.from({length:max+1},(_,i)=>'<span data-selected="'+(i<=value)+'"></span>').join('')+'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+max+'" aria-valuenow="'+value+'"></span></span>';
        document.querySelector('#status').textContent=['Instantané','Moyen','Élevée','Très élevé','Pro'][value]+', '+(value+1)+' sur '+(max+1)+'.'; }
      control.onclick=()=>{menu.hidden=false;control.setAttribute('aria-expanded','true');view.dataset.modelPickerView='simple';render()};
      document.querySelector('[data-model-picker-view-toggle]').onclick=()=>{view.dataset.modelPickerView='advanced';render()};
      for(const radio of document.querySelectorAll('[data-family]'))radio.onclick=()=>{family=radio.dataset.family;value=0;view.dataset.modelPickerView='simple';render()};
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){setTimeout(()=>{menu.hidden=true;control.setAttribute('aria-expanded','false')},75)}
        else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){value=Math.max(0,Math.min(family==='5.6'?4:3,value+(e.key==='ArrowRight'?1:-1)));render();e.preventDefault()}});render();
      </script>`);
    const result = await detectChatGptAccountCapabilities(page);
    await page.locator('#picker').waitFor({state:'hidden'});
    expect(result.modelCapabilities?.families).toEqual(evidence.families);
    expect(result.proAvailable).toBe(true);
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Brouillon à conserver");
    const menu = await activateChatGptEffortMenu(page, page.locator('button'));
    await assertChatGptModelFamily(menu, "5.6", "max", 4);
    await expect(assertChatGptModelFamily(menu, "6", "max", 4)).rejects.toThrow();
    await page.close();
  } finally { await browser.close(); }
}, 30_000);
