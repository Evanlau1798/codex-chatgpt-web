import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { composerSyntheticFixtures } from "../tests/fixtures/composer-synthetic";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import { ChatGptPromptOperation } from "../src/adapters/chatgpt-web/prompt-operation";
import { chatGptPromptAttachmentTimeoutMs } from "../src/adapters/chatgpt-web/prompt-attachment-budget";
import { chatGptPromptAttachmentMismatch, insertChatGptComposerGuardedText, reanchorChatGptComposerCaret } from "../src/adapters/chatgpt-web/prompt-caret";
import { chatGptPromptTextEquivalent, readChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-text";
import { planChatGptPromptInsertion, type ChatGptPromptInsertionOptions } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import type { ChatGptPromptInsertionSnapshot } from "../src/adapters/chatgpt-web/prompt-insertion-metrics";

/** Explicit offline Chromium fixture. No profile, account, remote URL, broker, or Send operation. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => !arg.startsWith("--chromium=") && arg !== "--large")) {
    throw new Error("Only --chromium=<installed executable> and optional --large are supported");
  }
  const executable = args.find(arg => arg.startsWith("--chromium="))?.slice("--chromium=".length);
  if (!executable || !existsSync(executable)) {
    throw new Error("Supply --chromium=<installed Chromium/Chrome executable>; this probe never installs a browser");
  }
  const root = resolve(import.meta.dir, "..");
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  if (sha.exitCode !== 0) throw new Error("Cannot identify the candidate commit");
  const cases: Array<{ id: string; text: string; options?: ChatGptPromptInsertionOptions; remount?: boolean }> =
    composerSyntheticFixtures().map(fixture => ({ id: fixture.id, text: fixture.text, options: { largeStructuredDirect: true } }));
  for (const size of [15_999, 16_000, 16_001, 32_000, 32_001]) {
    cases.push({ id: `exact-boundary-${size}`, text: "x".repeat(size), options: { largeStructuredDirect: true } });
  }
  cases.push({ id: "direct-cr-nul", text: "x".repeat(32_010) + "\r\u0000\nend", options: { largeStructuredDirect: true } });
  cases.push({ id: "editor-root-remount", text: "x".repeat(16_010) + "\nend", remount: true });
  if (args.includes("--large")) {
    cases.push({ id: "multipart-350k-plain", text: "x".repeat(350_000) });
    cases.push({ id: "multipart-330k-dense", text: composerSyntheticFixtures().find(fixture => fixture.id === "c03")!.text });
  }
  const browser = await chromium.launch({ executablePath: resolve(executable), headless: true });
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  let falseAcceptances = 0;
  try {
    for (const fixture of cases) {
      const context = await browser.newContext();
      await context.route("**/*", route => route.abort());
      const page = await context.newPage();
      // Temporary empty context only. The supplied fixture text is never executable markup.
      await page.setContent('<div id="prompt-textarea" contenteditable="true" style="white-space: pre-wrap"></div>');
      if (fixture.remount) await page.evaluate(() => {
        document.addEventListener("input", () => {
          const editor = document.getElementById("prompt-textarea")!;
          editor.replaceWith(editor.cloneNode(true));
        }, { once: true });
      });
      const composer = page.locator("#prompt-textarea");
      const started = performance.now();
      const op = new ChatGptPromptOperation().budget(chatGptPromptAttachmentTimeoutMs(fixture.text.length, false));
      let summary: ChatGptPromptInsertionSnapshot | undefined;
      let readbacks = 0;
      const row: Record<string, unknown> = { id: fixture.id, strategy: planChatGptPromptInsertion(fixture.text, fixture.options).strategy };
      try {
        await insertChatGptPromptText(fixture.text, undefined, {
          composer: async () => composer,
          verify: async expected => {
            readbacks++;
            const observed = await op.read(() => composer.evaluate(readChatGptPromptText));
            if (!chatGptPromptTextEquivalent(expected, observed)) {
              throw chatGptPromptAttachmentMismatch("Offline fixture rejected changed text", expected, observed);
            }
          },
          reanchor: async () => {
            if (!await reanchorChatGptComposerCaret(composer, 2, undefined, op)) throw new Error("Offline fixture caret failed");
          },
          onProgress: value => { if (value.event === "summary") summary = value; },
        }, fixture.options, op);
        // Expected text is the independent fixture literal under the existing trimStart contract.
        const expected = fixture.text.trimStart();
        const observed = await composer.evaluate(readChatGptPromptText);
        if (!chatGptPromptTextEquivalent(expected, observed)) throw new Error("Final fixture comparison failed");
        row.status = "PASS";
        // Mutate the actual DOM, then use the production reader and comparator. Never repair it.
        await composer.evaluate(element => { element.appendChild(document.createTextNode("\n")); });
        if (chatGptPromptTextEquivalent(expected, await composer.evaluate(readChatGptPromptText))) {
          falseAcceptances++;
          throw new Error("Injected LF corruption was accepted");
        }
      } catch (error) {
        failures++;
        row.status = "FAIL";
        row.errorCode = typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code : error instanceof Error ? error.name : "unknown";
      } finally {
        row.elapsedMs = Math.round(performance.now() - started);
        row.readbacks = readbacks;
        row.summary = summary;
        // Dispose the entire fixture context before the next case, including on uncertain edits.
        await context.close();
      }
      results.push(row);
      console.log(`[composer-fixture] ${fixture.id} ${row.status} strategy=${row.strategy}`);
    }
    {
      const context = await browser.newContext();
      await context.route("**/*", route => route.abort());
      const page = await context.newPage();
      await page.setContent('<div id="prompt-textarea" contenteditable="true"></div>');
      const controller = new AbortController();
      const reason = new DOMException("Offline fixture cancellation", "AbortError");
      page.on("console", message => { if (message.text() === "fixture-edit-start") controller.abort(reason); });
      await page.evaluate(() => {
        const original = document.execCommand.bind(document);
        document.execCommand = (command, showUi, value) => {
          console.debug("fixture-edit-start");
          const until = performance.now() + 100;
          while (performance.now() < until) { /* Deliberately hold the one native edit in this isolated fixture. */ }
          return original(command, showUi, value);
        };
      });
      let cancelled = false;
      try {
        await insertChatGptComposerGuardedText(page.locator("#prompt-textarea"), "inert fixture", controller.signal);
      } catch (error) {
        cancelled = controller.signal.aborted && error instanceof Error
          && (error === reason || error.name === "ChatGptPersistentBrowserStateError");
      } finally { await context.close(); }
      const isolated = page.isClosed();
      if (!cancelled || !isolated) failures++;
      results.push({ id: "cancel-native-edit", status: cancelled && isolated ? "PASS" : "FAIL",
        cancellationObserved: cancelled, previousContextClosed: isolated });
    }
    for (const [expected, corrupted] of [["a\nb", "ab"], ["ab", "ba"], ["a\u00a0b", "a b"]]) {
      if (chatGptPromptTextEquivalent(expected!, corrupted!)) { falseAcceptances++; failures++; }
    }
    const report = { commit: sha.stdout.toString().trim(), platform: process.platform, bun: Bun.version,
      worktreeDirty: Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: root }).exitCode !== 0,
      runnerTracked: Bun.spawnSync(["git", "ls-files", "--error-unmatch", "scripts/check-composer-reliability.ts"], { cwd: root }).exitCode === 0,
      browser: browser.version(), representation: "standalone-contenteditable-not-ChatGPT-Lexical",
      provenance: "synthetic-only", largeLane: args.includes("--large"),
      cases: results.length, failures, falseAcceptances, results };
    const output = join(root, "tmp", "composer-reliability");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, "fixture-result.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(output, "fixture-result.md"), [
      "# Offline composer fixture", `Commit: ${report.commit}`, `Browser: ${report.browser}`,
      "Synthetic-only standalone contenteditable; not ChatGPT Lexical or incident reproduction.",
      `Cases: ${report.cases}; failures: ${failures}; false acceptances: ${falseAcceptances}.`,
      ...results.map(row => `- ${row.id}: ${row.status} (${row.strategy}, ${row.elapsedMs} ms)`), "",
    ].join("\n"), { mode: 0o600 });
    console.log(`[composer-fixture] cases=${results.length} failures=${failures} falseAcceptances=${falseAcceptances}`);
    if (failures) process.exitCode = 1;
  } finally { await browser.close(); }
}

if (import.meta.main) await main();
