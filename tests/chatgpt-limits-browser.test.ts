import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { detectChatGptLimitsPlan } from "../src/adapters/chatgpt-web/limits";

// Optional real-browser contract, with all requests served from fixtures and no account.
const executablePath = process.env.CHATGPT_DOM_TEST_BROWSER;
for (const modern of [false, true]) test.skipIf(!executablePath)(`Billing inspection preserves account and page in ${modern ? "page" : "dialog"} layout`, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    let plan = "ChatGPT Pro 5x";
    let changedAccount = false;
    let sessionReads = 0;
    let subscriptionClicks = 0;
    const row = () => `<div class="@container/settings-row"><div>${plan}</div><button onclick="fetch('/subscription-click')">プランを変更</button></div>`;
    const billing = () => `${row()}<table><tr><td>ChatGPT Pro 20x</td></tr></table><p>Upgrade to ChatGPT Pro 20x</p>`;
    await context.route("**/*", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/auth/session") {
        sessionReads++;
        return route.fulfill({ json: { user: { id: "u" }, account: {
          id: changedAccount && sessionReads % 2 === 0 ? "different" : "a", planType: "pro", structure: "personal",
        } } });
      }
      if (pathname === "/subscription-click") { subscriptionClicks++; return route.fulfill({ body: "" }); }
      const html = modern
        ? pathname === "/settings/billing" ? `<main>${billing()}</main>`
          : '<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox">Draft</div></form>'
        : `<button data-testid="accounts-profile-button" style="position:relative;z-index:1" onclick="document.querySelector('[data-testid=settings-menu-item]').hidden=false">Profile</button>
          <button data-testid="accounts-profile-button" style="position:absolute;left:8px;top:8px;opacity:0;pointer-events:none">Inactive sidebar profile</button>
          <button data-testid="settings-menu-item" hidden onclick="this.hidden=true;document.querySelector('[role=dialog]').hidden=false">Settings</button>
          <div role="dialog" hidden><button role="tab" id="settings-trigger-Billing">Billing</button>
          <div role="tabpanel" id="settings-content-Billing"><h2>${plan}</h2><table><tr><td>ChatGPT Pro 20x</td></tr></table></div></div>
          <script>document.addEventListener('keydown', e => {if(e.key==='Escape')document.querySelector('[role=dialog]').hidden=true})</script>`;
      return route.fulfill({ contentType: "text/html", body: html });
    });
    const page = await context.newPage();
    await page.bringToFront();
    const start = "https://chatgpt.com/?temporary-chat=true";
    for (plan of ["ChatGPT Pro 5x", "ChatGPT Pro 20x", "ChatGPT Pro unknown"]) {
      await page.goto(start);
      if (plan.endsWith("unknown")) await expect(detectChatGptLimitsPlan(page)).rejects.toThrow("Could not distinguish");
      else expect((await detectChatGptLimitsPlan(page)).plan).toBe(plan.endsWith("5x") ? "pro_100" : "pro_200");
      expect(page.url()).toBe(start);
      expect(await page.getByRole("dialog").filter({ visible: true }).count()).toBe(0);
    }
    plan = "ChatGPT Pro 5x";
    changedAccount = true;
    sessionReads = 0;
    await page.goto(start);
    await expect(detectChatGptLimitsPlan(page)).rejects.toThrow("account or subscription changed");
    expect(page.url()).toBe(start);
    expect(subscriptionClicks).toBe(0);
    await context.close();
  } finally { await browser.close(); }
}, 60_000);
