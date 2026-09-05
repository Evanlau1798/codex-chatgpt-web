import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
} from "../../src/chatgpt-session";
import {
  clearChatGptComposerInput,
  guardChatGptPromptChunkBoundary,
  guardChatGptPromptMarkdown,
  reanchorChatGptComposerCaret,
  restoreChatGptPromptMarkdown,
} from "../../src/adapters/chatgpt-web/prompt-caret";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  CHATGPT_UI_SETTLE_MS,
  MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS,
} from "../../src/adapters/chatgpt-web/browser-worker";
import { openChatGptConnectorPlusMenu } from "../../src/adapters/chatgpt-web/connector-plus-menu";

export const MARKDOWN_RESTORATION_PROBE_CHARS = 17_587;
const CONNECTOR_SELECTOR = '[data-id^="plugin:"][data-keyword]';

export function markdownRestorationProbeText(): string {
  const pattern = "field_name=value) [literal](target) `code` *bold* ~=~ payload ";
  const text = pattern.repeat(Math.ceil(MARKDOWN_RESTORATION_PROBE_CHARS / pattern.length))
    .slice(0, MARKDOWN_RESTORATION_PROBE_CHARS);
  return `${text.slice(0, CHATGPT_PROMPT_INSERT_CHUNK_CHARS)} ${text.slice(CHATGPT_PROMPT_INSERT_CHUNK_CHARS + 1)}`;
}

async function activeComposer(page: Page): Promise<Locator> {
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  await composer.first().waitFor({ state: "visible", timeout: 20_000 });
  if (await composer.count() !== 1) throw new Error("Markdown restoration probe requires one visible composer");
  return composer.first();
}

async function editableText(composer: Locator): Promise<string> {
  return composer.evaluate((element, ignoredSelector) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`${ignoredSelector}, [data-inline-selection-pill-cursor-target]`)
      .forEach(part => part.remove());
    return Array.from(clone.childNodes, child => child.textContent ?? "").join("\n").trimStart();
  }, CONNECTOR_SELECTOR, { timeout: 20_000 });
}

async function connectorState(composer: Locator): Promise<string[]> {
  return composer.evaluate((element, selector) => Array.from(
    (element.closest("form") ?? element).querySelectorAll(selector),
    node => node.getAttribute("data-keyword") ?? "",
  ), CONNECTOR_SELECTOR, { timeout: 20_000 });
}

async function waitForText(composer: Locator, expected: string, abortSignal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 20_000;
  do {
    if (abortSignal?.aborted) throw abortSignal.reason;
    if (await editableText(composer) === expected) return;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`Markdown restoration probe text mismatch (expectedChars=${expected.length})`);
}

async function selectConnector(page: Page, appName: string): Promise<Locator> {
  let composer = await activeComposer(page);
  const selected = () => composer.locator("xpath=ancestor::form[1]")
    .locator(CONNECTOR_SELECTOR)
    .filter({ hasText: appName, visible: true });
  const verifySelected = async (): Promise<Locator> => {
    composer = await activeComposer(page);
    const control = selected();
    await control.waitFor({ state: "visible", timeout: 10_000 });
    if (await control.count() !== 1 || await control.getAttribute("data-keyword") !== appName) {
      throw new Error("Markdown restoration probe did not select the expected connector");
    }
    return composer;
  };
  if (await selected().count() === 1) return composer;

  const plusRow = await openChatGptConnectorPlusMenu(page, appName);
  if (plusRow) {
    await plusRow.press("Enter", { timeout: 10_000 });
    return await verifySelected();
  }

  const menuRows = page.locator('.__menu-item[tabindex="0"]');
  const exactRow = menuRows.filter({ has: page.getByText(appName, { exact: true }) });
  let attempt = 0;
  while (attempt < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
    attempt += 1;
    composer = await activeComposer(page);
    await composer.fill("");
    await composer.focus();
    await Bun.sleep(CHATGPT_UI_SETTLE_MS);
    await composer.pressSequentially("@codex", { delay: 25, timeout: 10_000 });
    try {
      await exactRow.waitFor({ state: "visible", timeout: 2_500 });
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      if (attempt === MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        throw new Error(`Markdown restoration probe could not find connector after ${attempt} attempts`);
      }
    }
  }
  if (await exactRow.count() !== 1) {
    throw new Error("Markdown restoration probe did not find one exact connector row");
  }
  const rowHighlighted = async () => await exactRow.getAttribute("data-highlighted") !== null;
  if (!await rowHighlighted()) {
    const visibleRows = await menuRows.filter({ visible: true }).count();
    for (let index = 0; index < visibleRows && !await rowHighlighted(); index += 1) {
      await composer.press("ArrowDown", { timeout: 10_000 });
    }
  }
  if (!await rowHighlighted()) {
    throw new Error("Markdown restoration probe could not highlight the expected connector");
  }
  await composer.press("Enter", { timeout: 10_000 });
  if (await selected().count() > 1) {
    throw new Error("Markdown restoration probe did not select the expected connector");
  }
  return await verifySelected();
}

export async function runMarkdownRestorationProbe(
  page: Page,
  appName: string,
  abortSignal?: AbortSignal,
): Promise<true> {
  const prompt = markdownRestorationProbeText();
  const guarded = guardChatGptPromptMarkdown(prompt);
  if (!guarded) throw new Error("Markdown restoration probe did not produce guard markers");
  const initialUserTurns = await page.locator(CHATGPT_USER_TURN_SELECTOR).count();
  let composer = await activeComposer(page);
  await clearChatGptComposerInput(composer);
  composer = await selectConnector(page, appName);
  const connectors = await connectorState(composer);
  if (connectors.length !== 1 || connectors[0] !== appName) {
    throw new Error("Markdown restoration probe requires one selected connector");
  }
  try {
    await composer.focus();
    for (let offset = 0; offset < guarded.text.length; offset += CHATGPT_PROMPT_INSERT_CHUNK_CHARS) {
      if (abortSignal?.aborted) throw abortSignal.reason;
      const original = guarded.text.slice(offset, offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
      const boundary = guardChatGptPromptChunkBoundary(guarded.text, original, offset);
      const chunk = boundary?.text ?? original;
      await page.keyboard.insertText(chunk);
      composer = await activeComposer(page);
      await waitForText(composer, `${guarded.text.slice(0, offset)}${chunk}`, abortSignal);
      if (boundary && !await restoreChatGptPromptMarkdown(
        composer,
        [boundary.replacement],
        1,
        CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
        abortSignal,
      )) throw new Error("Markdown restoration probe could not restore a chunk boundary");
      if (!await reanchorChatGptComposerCaret(composer)) {
        throw new Error("Markdown restoration probe could not re-anchor the composer");
      }
    }
    composer = await activeComposer(page);
    if (!await restoreChatGptPromptMarkdown(
      composer,
      guarded.replacements,
      guarded.count,
      CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
      abortSignal,
    )) throw new Error("Markdown restoration probe could not restore literal delimiters");
    await waitForText(composer, prompt, abortSignal);
    if (JSON.stringify(await connectorState(composer)) !== JSON.stringify(connectors)) {
      throw new Error("Markdown restoration probe changed connector state");
    }
    if (await page.locator(CHATGPT_USER_TURN_SELECTOR).count() !== initialUserTurns
      || await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count() !== 0) {
      throw new Error("Markdown restoration probe unexpectedly submitted a turn");
    }
    return true;
  } finally {
    composer = await activeComposer(page);
    await clearChatGptComposerInput(composer);
    if (await editableText(composer) !== "") throw new Error("Markdown restoration probe could not clear the composer");
    if ((await connectorState(composer)).length !== 0) {
      throw new Error("Markdown restoration probe could not clear connector state");
    }
    const send = composer.locator("xpath=ancestor::form[1]").getByTestId("send-button");
    if (await send.isEnabled().catch(() => false)
      || await page.locator(CHATGPT_USER_TURN_SELECTOR).count() !== initialUserTurns) {
      throw new Error("Markdown restoration probe cleanup left submittable content");
    }
  }
}
