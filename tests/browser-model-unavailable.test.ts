import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chromium, type Page } from "playwright-core";
import { ChatGptSubmissionRejectionObserver, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTerminalErrorRetryPrompt } from "../src/adapters/chatgpt-web/same-surface-recovery";

function fixture() {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
  const rejected: Error[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => rejected.push(error));
  observer.begin(page as unknown as Page);
  const request = (url = "https://chatgpt.com/backend-api/f/conversation", owner = frame) => ({
    method: () => "POST", url: () => url, frame: () => owner,
    postDataJSON: () => ({ model: "gpt-6-thinking", thinking_effort: "extended", messages: ["PRIVATE PROMPT"] }),
  });
  const respond = (req: unknown, body: unknown, status = 404) => page.emit("response", {
    request: () => req, status: () => status, headers: () => ({ "content-type": "application/json" }),
    json: async () => body,
  });
  return { page, observer, request, respond, rejected };
}

for (const body of [{ detail: "Model not found" }, { detail: { code: "model_not_found" } },
  { error: { code: "model_not_found" } }]) {
  test(`owned model rejection stops before an assistant DOM exists: ${JSON.stringify(body)}`, async () => {
    const f = fixture();
    try {
      f.observer.activate();
      const req = f.request(); f.page.emit("request", req); f.respond(req, body);
      const error = await f.observer.failure();
      expect(error).toMatchObject({ code: "model_not_found", status: 404, retryable: false, retireSession: true });
      expect(error?.message).toContain("Model not found");
      expect(f.rejected).toEqual([error!]);
      expect(chatGptTerminalErrorRetryPrompt(error!, 1, "")).toBeUndefined();
      expect(f.observer.hasActiveResponse()).toBeFalse();
      expect(f.observer.diagnosticSummary()).toMatchObject({
        models: [{ model: "gpt-6-thinking", thinkingEffort: "extended" }], statuses: [404],
      });
      expect(JSON.stringify(f.observer.diagnosticSummary())).not.toContain("PRIVATE PROMPT");
    } finally { f.observer.dispose(); }
    expect(f.page.listenerCount("response")).toBe(0);
  });
}

test("a model rejection from another frame, endpoint, or earlier submission is not authoritative", async () => {
  const f = fixture();
  try {
    const stale = f.request(); f.page.emit("request", stale);
    f.observer.activate(); f.respond(stale, { detail: "Model not found" });
    for (const req of [f.request(undefined, {}), f.request("https://chatgpt.com/backend-api/models"),
      f.request("https://other.example/backend-api/f/conversation")]) {
      f.page.emit("request", req); f.respond(req, { detail: "Model not found" });
    }
    expect(await f.observer.failure()).toBeUndefined();
    expect(f.rejected).toEqual([]);
  } finally { f.observer.dispose(); }
});

test.each([{ detail: "Conversation not found" }, { detail: { code: "other_error" } }, {}])(
  "a generic 404 does not prove model unavailability: %j", async body => {
    const f = fixture();
    try {
      f.observer.activate(); const req = f.request(); f.page.emit("request", req); f.respond(req, body);
      expect(await f.observer.failure()).toBeUndefined();
      expect(f.rejected).toEqual([]);
    } finally { f.observer.dispose(); }
  },
);

test("reset cancels an old delayed model rejection", async () => {
  const f = fixture();
  f.observer.activate(); const req = f.request(); f.page.emit("request", req);
  let finish!: (body: unknown) => void;
  const delayed = new Promise(resolve => { finish = resolve; });
  f.page.emit("response", { request: () => req, status: () => 404,
    headers: () => ({ "content-type": "application/json" }),
    json: () => delayed,
  });
  const old = f.observer.failure();
  f.observer.begin(f.page as unknown as Page);
  finish({ detail: "Model not found" });
  expect(await old).toBeUndefined();
  expect(f.rejected).toEqual([]);
  f.observer.dispose();
});

test("model diagnostics cannot contain arbitrary request text", () => {
  const f = fixture();
  try {
    f.observer.activate();
    for (let n = 0; n < 12; n++) {
      const req = { ...f.request(), postDataJSON: () => ({ model: "PRIVATE MODEL\nPROMPT", thinking_effort: "PRIVATE" }) };
      f.page.emit("request", req);
    }
    expect(JSON.stringify(f.observer.diagnosticSummary())).not.toContain("PRIVATE");
  } finally { f.observer.dispose(); }
});

test("owned model diagnostics stay bounded and reset with ownership", () => {
  const f = fixture();
  try {
    f.observer.activate();
    for (let n = 0; n < 12; n++) f.page.emit("request", f.request());
    expect(f.observer.diagnosticSummary().models).toHaveLength(8);
    f.observer.begin(f.page as unknown as Page);
    expect(f.observer.diagnosticSummary().models).toEqual([]);
  } finally { f.observer.dispose(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("real owned browser 404 aborts promptly without response DOM or message replay", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  let requests = 0;
  const failures: Error[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => failures.push(error));
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", route => {
      if (route.request().url().endsWith("/backend-api/f/conversation")) {
        requests++;
        return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Model not found"}' });
      }
      return route.fulfill({ contentType: "text/html", body: "<html><body>No assistant response exists.</body></html>" });
    });
    await page.goto("https://chatgpt.com/");
    observer.begin(page); observer.activate();
    await page.evaluate(async () => {
      await fetch("/backend-api/f/conversation", { method: "POST", body: JSON.stringify({ model: "gpt-6-thinking" }) });
    });
    expect(await observer.failure()).toMatchObject({ code: "model_not_found", retryable: false });
    expect(failures).toHaveLength(1);
    expect(await page.locator('[data-message-author-role="assistant"]').count()).toBe(0);
    expect(requests).toBe(1);
  } finally { observer.dispose(); await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("exact live model alert without a retry testid is recognized, ordinary text is not", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<article id="old"><aside role="alert">Model not found<button>Retry</button></aside></article>'
      + '<article id="current"><p>The server said Model not found.</p></article>');
    await throwIfChatGptTerminalErrorAlert(page.locator("#current"));
    await page.locator("#current").evaluate(e => e.innerHTML = '<aside role="alert">Model not found<button>重試</button></aside>');
    await expect(throwIfChatGptTerminalErrorAlert(page.locator("#current"))).rejects.toMatchObject({
      code: "model_not_found", retryable: false, retireSession: true,
    });
    await page.locator("#current button").evaluate(e => e.setAttribute("data-testid", "regenerate-thread-error-button"));
    await expect(throwIfChatGptTerminalErrorAlert(page.locator("#current"))).rejects.toMatchObject({ code: "model_not_found" });
    await throwIfChatGptTerminalErrorAlert(page.locator("#current"), true);
  } finally { await browser.close(); }
}, 15_000);
