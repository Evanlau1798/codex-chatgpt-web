import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { atomicWriteFile, getConfigDir } from "../../config";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
} from "../../chatgpt-session";
import type { ChatGptAssistantTurnBinding } from "./response-turn-boundary";
import { withChatGptBrowserObservationTimeout } from "./browser-observation";

const SAFE_STRING_KEYS = new Set(["tag", "role", "ariaExpanded", "ariaChecked", "dataState", "dataHighlighted", "origin"]);
export function sanitizeChatGptBrowserDiagnosticState(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeChatGptBrowserDiagnosticState);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (typeof candidate === "string") return SAFE_STRING_KEYS.has(key) && candidate.length <= 200 ? [[key, candidate]] : [];
    const sanitized = sanitizeChatGptBrowserDiagnosticState(candidate);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "checkpoint";
}

export function browserDiagnosticIncludesScreenshot(
  _checkpoint: string,
  captureAll = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1",
): boolean {
  return captureAll;
}

function diagnosticScreenshotMask(page: Page) {
  return [
    page.locator('[data-testid^="conversation-turn-"]'),
    page.locator(CHATGPT_COMPOSER_SELECTOR),
    page.locator('[role="dialog"], [role="alert"], [role="status"], [data-radix-popper-content-wrapper]'),
    page.locator('[data-testid*="profile" i], [data-testid*="account" i], [aria-label*="profile" i], [aria-label*="account" i]'),
  ];
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
}

function pruneBrowserDiagnostics(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
    .map(entry => {
      const path = join(root, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
    rmSync(trace.path, { recursive: true, force: true });
  }
}

function diagnosticError(error: unknown): string {
  return redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error));
}

function verificationFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["chatgpt_connector_unavailable", "chatgpt_rate_limited", "chatgpt_session_expired", "chatgpt_surface_changed"].includes(code)
    ? code : "verification_failed";
}

export class ChatGptBrowserDiagnostics {
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;
  private assistantTurnBinding?: ChatGptAssistantTurnBinding;

  constructor(
    private readonly traceId: string,
    private readonly root = join(getConfigDir(), "diagnostics", "browser-turns"),
    private readonly contentFree = false,
  ) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  bindAssistantTurn(binding: ChatGptAssistantTurnBinding): void {
    this.assistantTurnBinding = { ...binding };
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    try {
      this.initialize();
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const capturedAt = new Date().toISOString();
      let state: unknown = null;
      let stateError: string | undefined;
      try {
        state = await withChatGptBrowserObservationTimeout(this.contentFree
          ? captureVerificationCapabilities(page)
          : captureBrowserDiagnosticState(page, this.assistantTurnBinding));
      } catch (captureError) {
        stateError = this.contentFree ? verificationFailure(captureError) : diagnosticError(captureError);
      }

      const envelope: Record<string, unknown> = {
        version: 2,
        capturedAt,
        traceId: this.traceId,
        checkpoint,
        ...(error !== undefined ? { error: this.contentFree ? verificationFailure(error) : diagnosticError(error) } : {}),
        state: sanitizeChatGptBrowserDiagnosticState(state),
        ...(stateError ? { stateError } : {}),
      };
      const jsonPath = join(this.directory, `${stem}.json`);
      this.writeEnvelope(jsonPath, envelope);

      if (!this.contentFree && browserDiagnosticIncludesScreenshot(checkpoint)) {
        try {
          const mask = diagnosticScreenshotMask(page);
          const screenshot = await page.screenshot({ animations: "disabled", caret: "hide", mask, timeout: 5_000, type: "png" });
          atomicWriteFile(join(this.directory, `${stem}.png`), screenshot);
        } catch (screenshotCaptureError) {
          envelope.screenshotError = diagnosticError(screenshotCaptureError);
          this.writeEnvelope(jsonPath, envelope);
          console.warn(
            `[chatgpt-web] browser diagnostic screenshot failed trace=${this.traceId}`
            + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}: ${envelope.screenshotError}`,
          );
        }
      }
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem}${this.contentFree ? "" : ` path=${this.directory}`}`);
    } catch (captureError) {
      console.warn(
        `[chatgpt-web] browser diagnostic capture failed trace=${this.traceId}`
        + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}: ${this.contentFree ? verificationFailure(captureError) : diagnosticError(captureError)}`,
      );
    }
  }

  private initialize(): void {
    if (this.initialized) return;
    privateDirectory(this.root);
    privateDirectory(this.directory);
    pruneBrowserDiagnostics(this.root);
    this.initialized = true;
  }

  private writeEnvelope(path: string, envelope: Record<string, unknown>): void {
    atomicWriteFile(path, `${JSON.stringify(envelope, null, 2)}\n`);
  }
}

async function captureVerificationCapabilities(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(selectors => {
    const rendered = (element: Element): boolean => {
      const candidate = element as HTMLElement;
      const style = getComputedStyle(candidate);
      return candidate.isConnected && style.display !== "none"
        && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const any = (selector: string, root: ParentNode = document): boolean =>
      [...root.querySelectorAll(selector)].some(rendered);
    const composers = [...document.querySelectorAll(selectors.composer)].filter(rendered);
    const composerForm = composers.length === 1 ? composers[0]!.closest("form") : null;
    return {
      composerVisible: composers.length === 1,
      connectorSelected: composerForm !== null
        && any('[data-id^="plugin:"][data-keyword]', composerForm),
      mentionMenuVisible: any('.__menu-item[tabindex="0"][data-id^="plugin:"][data-keyword], .__menu-item[tabindex="0"] [data-id^="plugin:"][data-keyword]'),
      effortControlVisible: any(selectors.effortControl),
      effortItemsVisible: any(selectors.effortItem),
      menuVisible: any('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]'),
      connectorRowsVisible: any('.__menu-item[tabindex="0"]'),
      overlayVisible: any('[role="dialog"], [role="alert"], [role="status"]'),
    };
  }, {
    composer: CHATGPT_COMPOSER_SELECTOR,
    effortControl: CHATGPT_EFFORT_CONTROL_SELECTOR,
    effortItem: CHATGPT_EFFORT_ITEM_SELECTOR,
  });
}

async function captureBrowserDiagnosticState(
  page: Page,
  binding?: ChatGptAssistantTurnBinding,
): Promise<unknown> {
  return page.evaluate(({ selectors, binding }) => {
    const rendered = (element: Element): boolean => {
      const candidate = element as HTMLElement;
      const style = getComputedStyle(candidate);
      return candidate.isConnected && style.display !== "none"
        && style.visibility !== "hidden" && style.opacity !== "0";
    };

    const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
      .filter(rendered).slice(-limit).map(element => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        testId: element.getAttribute("data-testid"),
        ariaExpanded: element.getAttribute("aria-expanded"),
        ariaChecked: element.getAttribute("aria-checked"),
        dataState: element.getAttribute("data-state"),
        textChars: (element.textContent ?? "").length,
      }));
    const scopedRows = (root: Element | null, selector: string, limit = 40) => root
      ? [...root.querySelectorAll(selector)].filter(rendered).slice(-limit).map(element => ({
          tag: element.tagName.toLowerCase(),
          dataKeyword: element.getAttribute("data-keyword"),
          textChars: (element.textContent ?? "").length,
        }))
      : [];
    const composers = [...document.querySelectorAll(selectors.composer)].filter(rendered);
    const composerForm = composers.length === 1 ? composers[0]!.closest("form") : null;
    const assistantTurns = [...document.querySelectorAll(selectors.assistantTurn)].filter(rendered);
    const latestAssistant = binding?.id
      ? assistantTurns.find(element => element.getAttribute("data-testid") === binding.id)
      : assistantTurns.at(binding?.ordinal ?? -1);
    const finalRoot = latestAssistant
      ? [...latestAssistant.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(candidate => candidate.closest("[data-streaming-response-status]") === null)
        .filter(rendered).at(-1)
      : undefined;
    const boundaryNodes = finalRoot
      ? [...(finalRoot.matches("[data-start], [data-end], [data-is-last-node]") ? [finalRoot] : []), ...finalRoot.querySelectorAll<HTMLElement>("[data-start], [data-end], [data-is-last-node]")]
      : [];
    const lastNode = finalRoot
      ? [...(finalRoot.matches("[data-is-last-node]") ? [finalRoot] : []), ...finalRoot.querySelectorAll<HTMLElement>("[data-is-last-node]")].at(-1)
      : undefined;
    const animations = finalRoot && typeof finalRoot.getAnimations === "function"
      ? finalRoot.getAnimations({ subtree: true })
      : [];
    const infiniteAnimations = animations.filter(animation => {
      const timing = animation.effect?.getTiming();
      const endTime = animation.effect?.getComputedTiming().endTime;
      return timing?.iterations === Infinity || endTime === Infinity;
    }).length;
    const finiteAnimations = animations.filter(animation => {
      const timing = animation.effect?.getTiming();
      const endTime = animation.effect?.getComputedTiming().endTime;
      const infinite = timing?.iterations === Infinity || endTime === Infinity;
      return !infinite && (animation.playState === "running" || animation.pending);
    }).length;
    return {
      location: { origin: location.origin, pathSegments: location.pathname.split("/").filter(Boolean).length,
        temporaryChat: new URL(location.href).searchParams.has("temporary-chat") },
      titleChars: document.title.length,
      surfaceId: (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown }).__CODEX_WEB_GPT_SURFACE_ID__ ?? null,
      bodyTextChars: document.body?.textContent?.length ?? 0,
      composer: {
        visibleCount: composers.length,
        textChars: composers.map(element => (element.textContent ?? "").length),
        composerSelectedConnectors: scopedRows(composerForm, '[data-id^="plugin:"][data-keyword]', 20),
        mentionMenuConnectors: rows('.__menu-item[tabindex="0"][data-id^="plugin:"][data-keyword], .__menu-item[tabindex="0"] [data-id^="plugin:"][data-keyword]', 20),
      },
      effortControls: rows(selectors.effortControl, 10),
      effortItems: rows(selectors.effortItem, 20),
      menus: rows('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]', 20),
      connectorRows: rows('.__menu-item[tabindex="0"]', 40),
      overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
      turns: {
        user: document.querySelectorAll('[data-testid^="conversation-turn-"][data-message-author-role="user"]').length,
        boundAssistant: binding ? {
          id: binding.id ?? null,
          ordinal: binding.ordinal,
          generation: binding.generation,
          present: latestAssistant !== undefined,
        } : null,
        assistant: assistantTurns.map(element => ({
          testId: element.getAttribute("data-testid"),
          textChars: (element.textContent ?? "").length,
          htmlChars: (element as HTMLElement).innerHTML.length,
        })),
      },
      completion: {
        actionVisible: latestAssistant
          ? [...latestAssistant.querySelectorAll(selectors.completionAction)].some(rendered)
          : false,
        globalActionVisible: [...document.querySelectorAll(selectors.completionAction)].some(rendered),
        boundaryProtocolPresent: boundaryNodes.length > 0,
        lastNodePresent: lastNode !== undefined,
        boundaryStart: lastNode?.getAttribute("data-start") ?? null,
        boundaryEnd: lastNode?.getAttribute("data-end") ?? null,
        finiteAnimations,
        infiniteAnimations,
      },
    };
  }, {
    selectors: {
      composer: CHATGPT_COMPOSER_SELECTOR,
      effortControl: CHATGPT_EFFORT_CONTROL_SELECTOR,
      effortItem: CHATGPT_EFFORT_ITEM_SELECTOR,
      assistantTurn: CHATGPT_ASSISTANT_TURN_SELECTOR,
      completionAction: CHATGPT_COMPLETION_ACTION_SELECTOR,
    },
    binding,
  });
}
