import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chromium } from "playwright-core";
import { chatGptResponseStructureLogEntries, chatGptResponseStructures } from "../src/adapters/chatgpt-web/browser-response-structure";
import { chatGptInteractionState } from "../src/adapters/chatgpt-web/browser-interaction-state";
import { ChatGptBrowserObservationTimeoutError, ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptSubmissionRejectionObserver, ChatGptTurnDomHealthTracker, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptAssistantTurnSelector, chatGptTurnContainerSelector } from "../src/chatgpt-session";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test("the largest response diagnostics survive the launcher's safe-log string limit intact", () => {
  const { sanitizeForExport } = require("../launcher/electron/logging.cjs");
  const structures = Array.from({ length: 3 }, () => ({
    truncated: true,
    nodes: Array.from({ length: 200 }, (_, index) => ({
      parent: index - 1, tag: "section", rendered: true, assistant: true, user: false,
      searchUnit: true, markdown: true, streamingStatus: true, activityStart: true, completionControl: true,
      alert: true, retryControl: true,
    })),
  }));
  const entries = chatGptResponseStructureLogEntries("a".repeat(128), "99-turn-failed", structures);
  expect(entries).toHaveLength(3);
  const prefix = "[chatgpt-web] response_structure ";
  for (let index = 0; index < entries.length; index++) {
    const exported = sanitizeForExport(entries[index]);
    expect(exported).not.toContain("[truncated]");
    const payload = JSON.parse(exported.slice(prefix.length));
    expect(payload.turnCount).toBe(3);
    expect(payload.turnIndex).toBe(index);
    expect(payload.turns[0].nodes).toHaveLength(200);
    expect(payload.turns[0].nodes[199][0]).toBe(198);
  }
  const empty = chatGptResponseStructureLogEntries("empty-trace", "99-turn-failed", []);
  expect(empty).toHaveLength(1);
  expect(JSON.parse(empty[0]!.slice(prefix.length)).turns).toEqual([]);
});

test("a browser security challenge is scoped to the owned submission and never retried automatically", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, isClosed: () => false });
  const errors: unknown[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => errors.push(error));
  observer.begin(page as any);
  observer.activate();
  const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
  const response = { request: () => request, status: () => 403, headers: () => ({ "cf-mitigated": "challenge" }) };
  page.emit("response", response);
  expect(await observer.failure()).toBeUndefined();
  page.emit("request", request); page.emit("response", response);
  expect(await observer.failure()).toMatchObject({ code: "chatgpt_security_check", retryable: false, status: 403 });
  expect(errors).toHaveLength(1);
  expect(observer.hasActiveResponse()).toBeFalse();
  observer.dispose();
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("response diagnostics retain wrapper ownership but omit private text, classes and identifiers", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<article><div data-content-search-unit-key="PRIVATE-unit">'
      + '<div class="PRIVATE-wrapper"><div data-conversation-role="assistant">'
      + '<div class="markdown PRIVATE-class" id="PRIVATE-id"><p>PRIVATE answer</p>'
      + '<a href="https://private.example">PRIVATE link</a></div></div></div></div>'
      + '<div class="turn-action-controls"><button aria-label="PRIVATE label">PRIVATE control</button></div></article>');
    const structure = await page.locator("article").evaluateAll(chatGptResponseStructures);
    expect(JSON.stringify(structure)).not.toContain("PRIVATE");
    expect(JSON.stringify(structure)).not.toContain("private.example");
    const nodes = structure[0]!.nodes;
    const assistant = nodes.findIndex(node => node.assistant);
    const markdown = nodes.find(node => node.markdown)!;
    expect(markdown.parent).toBe(assistant);
    expect(nodes[nodes[assistant]!.parent]!.searchUnit).toBeFalse();
    expect(nodes.some(node => node.searchUnit)).toBeTrue();
    expect(nodes.some(node => node.completionControl)).toBeTrue();
    await page.locator("article").evaluate(root => root.innerHTML = '<aside role="alert">PRIVATE error</aside>'
      + '<button data-testid="regenerate-thread-error-button">PRIVATE retry</button>');
    const errorStructure = await page.locator("article").evaluateAll(chatGptResponseStructures);
    expect(JSON.stringify(errorStructure)).not.toContain("PRIVATE");
    expect(errorStructure[0]!.nodes.some(node => node.alert)).toBeTrue();
    expect(errorStructure[0]!.nodes.some(node => node.retryControl)).toBeTrue();
    await page.locator("article").evaluate(root => root.innerHTML = '<div class="markdown">PRIVATE</div>'.repeat(300));
    const bounded = await page.locator("article").evaluateAll(chatGptResponseStructures);
    expect(bounded[0]!.truncated).toBeTrue();
    expect(bounded[0]!.nodes.length).toBeLessThanOrEqual(200);
  } finally { await browser.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an owned error survives removal of its assistant subtree without reading another turn", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section data-turn-key="old"><button data-testid="regenerate-thread-error-button">Retry</button></section>'
      + '<section data-turn-key="current"><div data-user-message-bubble>Prompt</div>'
      + '<div data-conversation-role="assistant">Working</div></section>');
    const identity = "group:assistant:current";
    const container = page.locator(chatGptTurnContainerSelector(identity));
    const answer = page.locator(chatGptAssistantTurnSelector(identity));
    await expect(throwIfChatGptTerminalErrorAlert(container)).resolves.toBeUndefined();
    await page.locator('[data-turn-key="current"] [data-conversation-role]').evaluate(element => element.remove());
    await container.evaluate(element => element.insertAdjacentHTML("beforeend",
      '<aside role="alert">Informational notice</aside>'));
    expect(await answer.count()).toBe(0);
    await expect(throwIfChatGptTerminalErrorAlert(container)).resolves.toBeUndefined();
    await container.evaluate(element => element.insertAdjacentHTML("beforeend",
      '<button data-testid="regenerate-thread-error-button">Retry</button>'));
    await expect(throwIfChatGptTerminalErrorAlert(container)).rejects.toMatchObject({ code: "upstream_server_error" });
    const observe = (ChatGptBrowserWorker.prototype as any).waitForMultipartAcknowledgement;
    await expect(observe.call({
      responseDomSnapshot: async () => ({ responsePresent: false, stoppedThinkingVisible: false,
        visibleText: "", fullHtml: "", completionActionVisible: false }),
      waitForTurnDomOrExternalProgress: async () => { throw new Error("Owned stage error was missed"); },
    }, page, answer, { acknowledgement: "ack" }, Date.now() + 1_000,
    undefined, undefined, undefined, container)).rejects.toMatchObject({ code: "upstream_server_error" });
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("picker diagnostics distinguish disabled, covered and stalled controls without exposing content", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="PRIVATE" disabled aria-disabled="true">PRIVATE account</button>');
    const disabled = await page.evaluate(chatGptInteractionState, { selector: "button", sampleFrames: false });
    expect(disabled.controls[0]).toMatchObject({ disabled: true, ariaDisabled: true, hiddenAncestor: false, centerHit: true });
    expect(JSON.stringify(disabled)).not.toContain("PRIVATE");
    await page.setContent('<button style="position:fixed;inset:10px;width:100px;height:40px">PRIVATE</button>'
      + '<div style="position:fixed;inset:0;z-index:10">PRIVATE overlay</div>');
    const covered = await page.evaluate(chatGptInteractionState, { selector: "button", sampleFrames: false });
    expect(covered.controls[0]).toMatchObject({ disabled: false, hiddenAncestor: false, centerHit: false });
    await page.evaluate(() => { window.requestAnimationFrame = () => 1; });
    const stalled = await page.evaluate(chatGptInteractionState, { selector: "button", sampleFrames: true });
    expect(stalled.frames!.count).toBe(0);
    expect(stalled.frames!.elapsedMs).toBeGreaterThanOrEqual(450);
    const { sanitizeForExport } = require("../launcher/electron/logging.cjs");
    const serialized = JSON.stringify({ ...stalled, controls: Array(10).fill(stalled.controls[0]) });
    expect(sanitizeForExport(serialized)).toBe(serialized);
  } finally { await browser.close(); }
});

test.each(["requestfinished", "requestfailed"])("owned SSE keeps a quiet response alive until %s, without declaring completion", async terminal => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, isClosed: () => false });
  const observer = new ChatGptSubmissionRejectionObserver();
  const request = (url = "https://chatgpt.com/backend-api/f/conversation", owner = frame) => ({
    method: () => "POST", url: () => url, frame: () => owner, failure: () => null,
  });
  const respond = (req: unknown, status = 200) => page.emit("response", {
    request: () => req, status: () => status,
    headers: () => ({ "content-type": "text/event-stream" }), text: async () => "data: [DONE]\n\n",
  });
  const old = request();
  page.emit("request", old);
  observer.begin(page as any);
  observer.activate();
  respond(old);
  for (const other of [request(undefined, {}), request("https://chatgpt.com/backend-api/sentinel")]) {
    page.emit("request", other); respond(other);
  }
  expect(observer.hasActiveResponse()).toBeFalse();
  const failed = request(); page.emit("request", failed); respond(failed, 503);
  expect(observer.hasActiveResponse()).toBeFalse();
  const current = request(); page.emit("request", current); respond(current);
  const health = new ChatGptTurnDomHealthTracker(60_000, 10_000, 60_000);
  const state = { responsePresent: true, running: false, currentText: "", completionActionVisible: false,
    projection: { rootId: "owned", boundaryProtocolPresent: false, lastNodePresent: true, lastMutationAt: 0, animations: [] } };
  for (const now of [0, 120_000, 173_000, 382_000, 1_410_000]) {
    expect(health.update({ ...state, responseStreamActive: observer.hasActiveResponse() }, now)).toBeUndefined();
  }
  const completion = new ChatGptCompletionTracker(100);
  // An open stream never substitutes for a final answer; nor may keepalives delay proven completion.
  expect(completion.update(state, 1_410_000).status).toBe("waiting");
  const final = { ...state, currentText: "Final answer", completionActionVisible: true };
  expect(completion.update(final, 1_410_000).status).toBe("waiting");
  expect(completion.update(final, 1_410_100).status).toBe("complete");
  page.emit(terminal, current);
  expect(observer.hasActiveResponse()).toBeFalse();
  expect(health.update(state, 1_410_000)).toBeUndefined();
  expect(health.update(state, 1_470_000)).toContain("without a final answer");
  expect(await observer.failure()).toBeUndefined();
  observer.dispose();
  expect(page.listenerCount("response")).toBe(0);
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("real Enter accepts MCP while the renderer is still busy handling the key", async () => {
  const progress = new ChatGptExternalTurnProgress();
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/invoke") {
      calls++;
      progress.recordToolBatch(1);
      return new Response("received");
    }
    return new Response('<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">test</div>'
      + '<button type="submit">Send</button></form><script>'
      + 'document.querySelector("button").onkeydown=event=>{if(event.key!=="Enter")return;event.preventDefault();'
      + 'fetch("/invoke",{method:"POST"});const end=performance.now()+2500;while(performance.now()<end){}}</script>',
      { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const baseline = await worker.captureSubmissionBaseline(page, "test");
    const started = performance.now();
    const accepted = await worker.runStage("slow_enter_test", "send", 1_500, (signal: AbortSignal) =>
      worker.sendAttachedPrompt(page, baseline, baseline.initialResponseTurn, undefined, signal, undefined, progress));
    expect(accepted).toBe("mcp_tool_call");
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(calls).toBe(1);
  } finally { await browser.close(); server.stop(true); }
}, 10_000);
