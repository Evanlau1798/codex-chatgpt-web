import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { ChatGptMarkdownOwnershipTracker } from "../src/adapters/chatgpt-web/markdown-ownership";
import { readFileSync } from "node:fs";

let browser: Browser;
beforeAll(async () => {
  if (process.env.CHATGPT_DOM_TEST_BROWSER) browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); });

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a transport connector prefix survives an optimistic response remount without relaxing prompt identity", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const prompt = "This is a diagnostic. Keep  two spaces.";
  for (const scenario of ["matching", "foreign-connector", "same-name-other-app", "changed-text", "changed-leading-space", "unbound-connector"] as const) {
    const page = await browser.newPage();
    try {
      await page.setContent('<main></main><form><div id="prompt-textarea" contenteditable="true"></div>'
        + '<span app-mention-path="app://test" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span></form>');
      let baseline = await worker.captureSubmissionBaseline(page, prompt);
      if (scenario !== "unbound-connector") baseline.connectorName = "Codex Native2";
      baseline = { ...baseline, ...await worker.captureSubmissionBaseline(page, prompt, baseline) };
      if (scenario !== "unbound-connector") expect(baseline.connectorMention).toEqual({ name: "Codex Native2", href: "app://test" });
      // Same-document attachment recovery must rebuild locators without losing the bound app ID.
      baseline = { ...baseline, ...await worker.captureSubmissionBaseline(page, prompt, baseline) };
      await page.locator("main").evaluate(e => e.innerHTML = '<div data-turn-key="optimistic"><span hidden data-chatgpt-agent-turn-start></span></div>');
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      const label = scenario === "foreign-connector" ? "Other connector" : "Codex Native2";
      const text = scenario === "changed-text" ? prompt.replace("  ", " ") : scenario === "changed-leading-space" ? " " + prompt : prompt;
      const href = scenario === "same-name-other-app" ? "app://foreign" : "app://test";
      await page.locator("main").evaluate((e, { label, text, href }) => {
        e.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">'
          + '<p><a href="/plugins/test"><span data-prompt-link-href="' + href + '" data-prompt-link-label="$codex-native2">'
          + label + '</span></a><span> ' + text + '</span></p></div></div>'
          + '<div data-conversation-role="assistant"></div></div>';
      }, { label, text, href });
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, binding)
        .then((value: { identity: string }) => ({ value, error: undefined }),
          (error: Error) => ({ value: undefined, error }));
      if (scenario === "matching") expect(result.value?.identity).toBe("group:assistant:persisted");
      else {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error!.message).toContain("another user turn");
      }
    } finally { await page.close(); }
  }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content update the response snapshot", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const turn = page.locator("#turn");
    const observe = () => worker.responseDomSnapshot(turn);
    const first = await observe();
    expect(first.traceBlocks.filter((block: any) => block.kind === "status")).toHaveLength(10);
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
    const summary = page.locator('[data-markdown-text-style="assistant-message"]')
      .filter({ has: page.getByText("status 1", { exact: true }) });
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "primary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("commentary");
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "tertiary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("status");
    await summary.evaluate(node => { node.parentElement!.hidden = true; });
    const collapsed = await observe();
    expect(collapsed.traceBlocks.some((block: any) => block.kind === "status" || block.kind === "commentary")).toBeFalse();
    expect(collapsed.visibleText).toBe("answer 1");
    await summary.evaluate(node => { node.parentElement!.hidden = false; });
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
  } finally { await context.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("preserves the accepted user identity across Activity's temporary fallback group", async () => {
  const context = await browser.newContext();
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt.\n\nReturn its contents.";
    // Captured on the installed launcher: the user group appears at Send, disappears
    // during Activity, then returns with the same ID and a rich-text user bubble.
    const user = '<div data-user-message-bubble><div data-search-result-target><p><span data-prompt-link-href="app://test">Codex Native</span> Read first.txt.<br>Return its contents.</p></div></div>';
    const answer = '<div data-content-search-unit-key="fallback-turn-0:2:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>FIRST fixture-marker</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    for (const scenario of ["same-user", "different-user", "competing-turn", "old-group-remains", "unfinished", "streaming"] as const) {
      const page = await context.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "different-user" ? "unrelated" : "submitted";
      const renderedUser = scenario === "different-user"
        ? `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>`
        : user;
      const response = scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>'
        : scenario === "streaming" ? answer.replace('<div class="turn-action-controls"><button>Copy</button></div>', "") : answer;
      let replacement = `<div data-turn-key="${key}">${renderedUser}${response}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      console.info("[prefix-probe] reconcile", scenario, Date.now());
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (["same-user", "unfinished", "streaming"].includes(scenario)) {
        expect((await result).identity).toBe("group:assistant:submitted");
      } else {
        await expect(result).rejects.toThrow("another user turn");
      }
      await page.close();
    }
  } finally { await context.close(); }
}, 15_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an exchange rekeys only with the exact submitted prompt and no competing turn", async () => {
  const context = await browser.newContext();
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      captureSubmissionBaseline(page: Page, submittedText?: string): Promise<unknown>;
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: number): Promise<Binding>;
      reconcileAssistantTurnBinding(page: Page, baseline: unknown, binding: Binding): Promise<Binding>;
    };
    type Binding = { identity: string; locator: Locator; acceptedTurnIdentities: string[] };
    const prompt = "Explain one thing.\nKeep  two spaces.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div><span aria-hidden="true">\u200b</span><button>Show more</button></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["matching", "history", "foreign", "prefix-only", "changed-spaces", "changed-edges", "two-turns", "old-group-remains", "unfinished", "no-prompt", "same-key"] as const) {
      const page = await context.newPage();
      const history = scenario === "history" ? group("earlier", prompt, true) : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, scenario === "no-prompt" ? undefined : prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, history + group("optimistic"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "foreign" ? "Different task."
        : scenario === "prefix-only" ? prompt + " Another request."
        : scenario === "changed-spaces" ? prompt.replace("  ", " ")
        : scenario === "changed-edges" ? " " + prompt : prompt;
      let html = history + group(scenario === "same-key" ? "optimistic" : "persisted", text, scenario !== "unfinished");
      if (scenario === "two-turns") html += group("foreign", prompt, true);
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"><div data-user-message-bubble>Earlier</div></div>';
      await page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      console.info("[prefix-probe] reconcile", scenario, Date.now());
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "matching" || scenario === "history" || scenario === "same-key" || scenario === "unfinished") {
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-key" ? "optimistic" : "persisted"}`);
        expect(await rebound.locator.count()).toBe(1);
      } else {
        // Await Playwright I/O before Bun assertions to avoid Windows event-loop re-entry.
        const error = await result.then(() => undefined, (error: Error) => error);
        expect(error).toBeInstanceOf(Error);
      }
      await page.close();
    }
  } finally { await context.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("collapsed plugin messages rebind only after their complete text is verified", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { appName: "Clew review" };
    const prompt = "Verify the entire message.\n\n" + "alpha  beta\n".repeat(1_000) + "END_MARKER";
    // Structure captured in the DEV launcher on 2026-10-15. The user content is
    // removed from the DOM when collapsed; the plugin and blank-line spans are real.
    const render = (value: string) => '<div data-markdown-text-tone="user-message" class="rich-text-user-turn">'
      + value.split("\n\n").map((paragraph, i) => (i ? '<span data-markdown-copy="blank-lines">\n</span>' : "")
        + '<p>' + (i ? "" : '<a href="/plugins/fixture"><span data-prompt-link-href="app://fixture">Clew review</span></a>  ')
        + paragraph.split("\n").map(line => `<span>${line}</span>`).join("<br>") + '</p>').join("") + '</div>';
    for (const scenario of ["complete", "different-tail", "changed-spaces", "wrong-plugin", "still-truncated", "competing-turn"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="optimistic"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      const collapsed = render(prompt.slice(0, 10_000));
      await page.locator('main').evaluate((e, html) => { e.innerHTML = html; }, `<div data-turn-key="persisted">
        <div data-user-message-bubble><div data-search-result-target>${collapsed}</div>
        <button type="button" aria-expanded="false" data-thread-find-skip="true" data-markdown-copy="exclude">Показать ещё</button></div>
        <div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">Complete answer</div></div>`);
      let expanded = render(scenario === "different-tail" ? prompt.replace("END_MARKER", "OTHER_TASK")
        : scenario === "changed-spaces" ? prompt.replace("alpha  beta", "alpha beta")
        : scenario === "still-truncated" ? prompt.slice(0, 10_000) : prompt);
      if (scenario === "wrong-plugin") expanded = expanded.replace("Clew review", "Other plugin");
      await page.locator('button').evaluate((button, { html, competing }) => {
        button.addEventListener('click', () => {
          button.setAttribute('aria-expanded', 'true');
          button.parentElement!.querySelector('[data-search-result-target]')!.innerHTML = html;
          if (competing) document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div data-turn-key="other"><div data-user-message-bubble>Another task</div></div>');
        });
      }, { html: expanded, competing: scenario === "competing-turn" });
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, binding)
        .then((value: unknown) => ({ value }), (error: Error) => ({ error }));
      if (scenario === "complete") expect(result.value).toMatchObject({ identity: "group:assistant:persisted" });
      else expect(result.error).toBeInstanceOf(Error);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("plain user code blocks preserve the full submitted code and whitespace", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = 'Literal header\n\n```json\n{"value":"a  b"}\n```\n\n\tEnd.';
    // Captured plain user-message renderer: only fenced code becomes an HTML block.
    await page.setContent('<div id="group"><div data-user-message-bubble><div data-search-result-target>'
      + 'Literal header\n\n<pre data-markdown-copy="code-block"><code data-markdown-copy-content="true" data-language="json">{"value":"a  b"}</code></pre>\n\n\tEnd.</div></div></div>');
    expect(await worker.userMessageMatchesSubmission(page.locator('#group'), prompt)).toBeTrue();
    expect(await worker.userMessageMatchesSubmission(page.locator('#group'), prompt.replace('a  b', 'a b'))).toBeFalse();
  } finally { await browser.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("rich-text rebind requires the exact prepared turn token after expansion", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const token = "turn_0123456789abcdef0123456789abcdef";
    const foreign = "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prompt = 'Task JSON with links.\nPass turn_token ' + token;
    for (const scenario of ["matching", "foreign", "missing", "duplicate", "token-prefix", "competing-turn"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt, [], token);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="pending"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble>'
        + '<div data-search-result-target><a data-search-result-target href="https://example.com">Altered JSON/link label</a></div>'
        + '<button type="button" aria-expanded="false" data-thread-find-skip="true" data-markdown-copy="exclude">Afficher plus</button></div>'
        + '<span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const displayed = scenario === "foreign" ? foreign : scenario === "missing" ? ""
        : scenario === "duplicate" ? `${token} ${token}` : scenario === "token-prefix" ? `${token}extra` : token;
      await page.locator('button').evaluate((button, { displayed, competing }) => {
        button.addEventListener('click', () => {
          button.setAttribute('aria-expanded', 'true');
          button.parentElement!.querySelector('[data-search-result-target]')!.append(' Pass turn_token ' + displayed);
          if (competing) document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div data-turn-key="other"><div data-user-message-bubble>Other task</div></div>');
        });
      }, { displayed, competing: scenario === "competing-turn" });
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, binding)
        .then((value: unknown) => ({ value }), (error: Error) => ({ error }));
      if (scenario === "matching") expect(result.value).toMatchObject({ identity: "group:assistant:persisted" });
      else expect(result.error).toBeInstanceOf(Error);
      const invalid = await worker.captureSubmissionBaseline(page, "No broker token here", [], token)
        .then(() => undefined, (error: Error) => error);
      expect(invalid).toBeInstanceOf(Error);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("read-only remounts require their non-authorizing submission identity after renderer rewriting", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const identity = "codexsubmission:0123456789abcdef0123456789abcdef";
  const foreign = "codexsubmission:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  worker.config = { appName: "Codex Native2" };
  try {
    for (const scenario of ["matching", "literal-other", "foreign", "missing", "duplicate", "prefix", "competing"] as const) {
      const page = await browser.newPage();
      const prompt = 'Literal `code` <context> C:\\repo\\file\n' + (scenario === "literal-other" ? `Example: ${foreign}\n` : "") + identity;
      await page.setContent('<main></main>');
      let baseline = await worker.captureSubmissionBaseline(page, prompt);
      baseline.submissionIdentity = identity;
      baseline = await worker.captureSubmissionBaseline(page, prompt, baseline);
      expect(baseline.submissionIdentity).toBe(identity);
      await page.locator('main').evaluate(e => { e.innerHTML = '<div data-turn-key="pending"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      const displayed = scenario === "foreign" ? foreign : scenario === "missing" ? ""
        : scenario === "duplicate" ? identity + " " + identity : scenario === "prefix" ? identity + "extra"
        : scenario === "literal-other" ? foreign + " " + identity : identity;
      await page.locator('main').evaluate((e, { displayed, competing }) => {
        e.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble><div data-search-result-target>'
          + '<div data-markdown-text-tone="user-message" class="rich-text-user-turn"><p>'
          + '<span>Literal \\`code\\` \\&lt;context&gt; C:\\\\repo\\\\file</span><br><span>' + displayed + '</span></p></div>'
          + '</div></div><span hidden data-chatgpt-agent-turn-start></span></div>'
          + (competing ? '<div data-turn-key="other"><div data-user-message-bubble>Another task</div></div>' : '');
      }, { displayed, competing: scenario === "competing" });
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, binding)
        .then((value: unknown) => ({ value }), (error: Error) => ({ error }));
      if (scenario === "matching" || scenario === "literal-other") expect(result.value).toMatchObject({ identity: "group:assistant:persisted" });
      else expect(result.error).toBeInstanceOf(Error);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("assistant-only rekeys remain provisional until submission ownership is proven", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const identity = "codexsubmission:0123456789abcdef0123456789abcdef";
  for (const scenario of ["matching", "foreign", "accepted-user"] as const) {
    const page = await browser.newPage();
    try {
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, "Exact prompt\n" + identity);
      baseline.submissionIdentity = identity;
      if (scenario === "accepted-user") baseline.acceptedUserIdentity = "group:user:owned";
      await page.locator("main").evaluate(e => { e.innerHTML = '<div data-turn-key="pending"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
      await page.locator("main").evaluate(e => { e.innerHTML = '<div data-turn-key="owned"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const provisional = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "accepted-user") {
        expect(provisional.identity).toBe("group:assistant:owned");
        continue;
      }
      expect(provisional).toBe(binding);
      const token = scenario === "matching" ? identity : "codexsubmission:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      await page.locator("main").evaluate((e, value) => {
        e.innerHTML = '<div data-turn-key="owned"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">'
          + value + '</div></div><span hidden data-chatgpt-agent-turn-start></span></div>';
      }, token);
      const result = await worker.reconcileAssistantTurnBinding(page, baseline, provisional)
        .then((value: unknown) => ({ value }), (error: Error) => ({ error }));
      if (scenario === "matching") expect(result.value).toMatchObject({ identity: "group:assistant:owned" });
      else expect(result.error).toBeInstanceOf(Error);
    } finally { await page.close(); }
  }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("binds captured Activity before an answer exists and recognizes uploaded native-button tiles", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request =>
    request.method === "POST" ? new Response('{"event":"file.processing.completed","file_id":"fixture-file"}\n',
      { headers: { "content-type": "application/x-ndjson" } }) : new Response("", { headers: { "content-type": "text/html" } }) });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main>');
    const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
    const html = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8");
    await page.locator("main").evaluate((node, content) => { node.innerHTML = content; }, html);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.identity).toBe("group:assistant:activity");
    expect((await worker.responseDomSnapshot(binding.locator)).traceBlocks.some((block: { kind: string }) => block.kind === "commentary")).toBeTrue();
    for (const tile of ['button', 'div role="button"']) {
      await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px">Prompt</div>
        <input type="file" multiple><${tile} class="composer-attachment-surface" aria-label="codex-input-image-1.png">File</${tile.split(' ')[0]}>
        <button type="submit">Send</button></form>`);
      await page.locator('input[type="file"]').evaluate(input => {
        input.addEventListener("change", () => void fetch("/backend-api/files/process_upload_stream", {
          method: "POST", body: JSON.stringify({ file_name: "codex-input-image-1.png", file_id: "fixture-file" }),
        }));
      });
      await worker.attachFiles(page, { images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      expect(await page.locator('input[type="file"]').evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe("codex-input-image-1.png");
    }
  } finally { await context.close(); server.stop(true); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("paragraph identity survives file preview movement in both response layouts", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
      const page = await browser.newPage();
      await page.setContent(`<section id="turn"><div data-content-search-unit-key="answer">
        <h4 data-conversation-role="assistant"></h4><div id="answer" ${root}>
        <p>Report saved:</p><p id="file">report.md</p><p id="tail">Done.</p>
      </div></div><button aria-label="Copy"></button></section>`);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const cache = new ChatGptMarkdownOwnershipTracker();
      const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
      const before = await observe();
      const buffer = new ChatGptMarkdownBuffer(undefined, 0);
      expect(buffer.observe(before.markdownSegments, 0)).toBe("Report saved:\n\nreport.md");
      await page.locator("#file").evaluate(file => { file.parentElement!.parentElement!.appendChild(file); });
      const moved = await observe();
      expect(moved.markdownSegments.at(-1).key).toBe(before.markdownSegments.at(-1).key);
      expect(buffer.observe(moved.markdownSegments, 1)).toBe("");
      await page.locator("#answer").evaluate(answer => { answer.innerHTML = answer.innerHTML; });
      buffer.observe((await observe()).markdownSegments, 2);
      expect(buffer.finish().markdown).toBe("Report saved:\n\nreport.md\n\nDone.");
      await page.locator("#tail").evaluate(tail => { tail.textContent = "A changed answer."; });
      buffer.observe((await observe()).markdownSegments, 3);
      expect(() => buffer.finish()).toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("CodeMirror language invalidates the response cache and incomplete code is not delivered", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-codemirror-reply-2026-10-11.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = new ChatGptMarkdownOwnershipTracker();
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```python\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => editor.setAttribute("data-language", "text"));
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```text\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => {
      const gap = document.createElement("div");
      gap.style.height = "200px";
      editor.appendChild(gap);
    });
    const error = await observe().then(() => undefined, (error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("one complete set of code lines");
  } finally { await browser.close(); }
});
