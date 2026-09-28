import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { detectChatGptLimitsPlan } from "../src/adapters/chatgpt-web/limits";

// Execute the production account reader without real credentials or changing any browser UI.
const executablePath = process.env.CHATGPT_DOM_TEST_BROWSER;
for (const scenario of ["pro", "prolite", "unknown", "account-change", "plan-change", "payment-change", "expired", "http-error", "redirect"])
test.skipIf(!executablePath)(`Limits account ${scenario} preserves the page and rejects uncertain state`, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    let sessionReads = 0;
    const requests: string[] = [];
    await context.route("**/*", async route => {
      const pathname = new URL(route.request().url()).pathname;
      requests.push(pathname);
      if (pathname === "/api/auth/session") {
        sessionReads++;
        if (scenario === "http-error") return route.fulfill({ status: 403, body: "Blocked" });
        if (scenario === "redirect") return route.fulfill({ status: 302, headers: { location: "/unexpected-session" } });
        return route.fulfill({ json: {
          accessToken: "private-session-token",
          expires: scenario === "expired" ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
          user: { id: "private-user" }, account: {
            id: scenario === "account-change" && sessionReads === 2 ? "different" : "private-account",
            planType: scenario === "unknown" ? "promax" : scenario === "prolite"
              || scenario === "plan-change" && sessionReads === 2 ? "prolite" : "pro",
            structure: "personal", isDelinquent: scenario === "payment-change" && sessionReads === 2,
          },
        } });
      }
      return route.fulfill({ contentType: "text/html", body: `<main>
        <h2>ChatGPT Pro: More usage</h2><p>Upgrade to Pro 20x</p><p>Pro 5x</p>
        <form><div contenteditable="true" role="textbox">Unsent draft</div></form>
        <dialog open>Unrelated dialog</dialog></main>` });
    });
    const page = await context.newPage();
    const start = "https://chatgpt.com/?temporary-chat=true";
    await page.goto(start);
    const original = await page.content();
    if (["account-change", "plan-change", "payment-change"].includes(scenario)) {
      await expect(detectChatGptLimitsPlan(page)).rejects.toThrow("account or subscription changed");
    } else if (scenario === "expired") {
      await expect(detectChatGptLimitsPlan(page)).rejects.toThrow("session has expired");
    } else if (["http-error", "redirect"].includes(scenario)) {
      await expect(detectChatGptLimitsPlan(page)).rejects.toThrow();
    } else {
      const result = await detectChatGptLimitsPlan(page);
      expect(result.plan).toBe(scenario === "unknown" ? "unsupported" : scenario === "prolite" ? "pro_100" : "pro_200");
      expect(JSON.stringify(result)).not.toContain("private-");
    }
    expect(page.url()).toBe(start);
    expect(await page.content()).toBe(original);
    expect(requests.every(path => path === "/" || path === "/api/auth/session")).toBeTrue();
  } finally { await browser.close(); }
}, 60_000);
