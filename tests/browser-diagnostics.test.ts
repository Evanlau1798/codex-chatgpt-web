import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptBrowserDiagnostics } from "../src/adapters/chatgpt-web/browser-diagnostics";

const diagnosticState = {
  url: "https://chatgpt.com/",
  title: "Temporary Chat",
  surfaceId: "surface-test",
  bodyTextChars: 100,
  composer: { visibleCount: 1, textChars: [0], composerSelectedConnectors: [], mentionMenuConnectors: [] },
  effortControls: [],
  effortItems: [],
  menus: [],
  connectorRows: [],
  overlays: [],
  turns: { user: 1, assistant: [{ textChars: 42, htmlChars: 80 }] },
  completion: {
    actionVisible: false,
    lastNodePresent: true,
    boundaryStart: "0",
    boundaryEnd: "42",
    finiteAnimations: 0,
    infiniteAnimations: 1,
  },
};

test("connector verification records only capabilities even when screenshots are enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-verification-private-"));
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
  let screenshots = 0;
  let verificationEvaluator = "";
  try {
    process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = "1";
    const page = {
      evaluate: async (evaluator: Function) => {
        verificationEvaluator = evaluator.toString();
        return {
          composerVisible: true, connectorSelected: false, mentionMenuVisible: false,
          effortControlVisible: false, effortItemsVisible: false, menuVisible: false,
          connectorRowsVisible: false, overlayVisible: false,
        };
      },
      locator: () => ({}),
      screenshot: async () => { screenshots++; return Buffer.from("private-image"); },
    } as unknown as Page;
    const capture = new ChatGptBrowserDiagnostics("verify_private_trace", root, true);
    await capture.capture(page, "connector-verification-started");
    await capture.capture(page, "connector-verification-failed", new Error("private-error"));
    const directory = join(root, readdirSync(root)[0]!);
    const files = readdirSync(directory).sort();
    expect(files.length).toBe(2);
    expect(screenshots).toBe(0);
    expect(verificationEvaluator).not.toMatch(/location\.href|document\.title|innerText|textContent/);
    for (const file of files) {
      const content = readFileSync(join(directory, file), "utf8");
      expect(content).not.toContain("private-");
      const entry = JSON.parse(content);
      expect(entry.traceId).toBe("verify_private_trace");
      expect(entry.state.composerVisible).toBe(true);
      expect(Object.values(entry.state).every(value => typeof value === "boolean")).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(directory, files[1]!), "utf8")).error).toBe("verification_failed");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function artifact(root: string, extension: string): string {
  const directory = join(root, readdirSync(root)[0]!);
  const name = readdirSync(directory).find(value => value.endsWith(extension));
  if (!name) throw new Error(`missing diagnostic ${extension}`);
  return join(directory, name);
}

test("preserves DOM diagnostic JSON when screenshot capture times out", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-diagnostic-"));
  try {
    let screenshotCalls = 0;
    const page = {
      evaluate: async () => diagnosticState,
      screenshot: async () => { screenshotCalls += 1; throw new Error("screenshot timeout"); },
    } as unknown as Page;
    await new ChatGptBrowserDiagnostics("trace_json_survives", root).capture(page, "turn-failed");

    const json = JSON.parse(readFileSync(artifact(root, ".json"), "utf8"));
    expect(json.state).toEqual(diagnosticState);
    expect(json.screenshotError).toBeUndefined();
    expect(screenshotCalls).toBe(0);
    expect(() => artifact(root, ".png")).toThrow("missing diagnostic .png");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opt-in screenshots mask sensitive UI regions and preserve the error envelope", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-diagnostic-"));
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
  try {
    process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = "1";
    const locatorSelectors: string[] = [];
    let screenshotOptions: Record<string, unknown> | undefined;
    const page = {
      evaluate: async () => { throw new Error("execution context unavailable"); },
      locator: (selector: string) => {
        locatorSelectors.push(selector);
        return { selector };
      },
      screenshot: async (options: Record<string, unknown>) => {
        screenshotOptions = options;
        return Buffer.from("png");
      },
    } as unknown as Page;
    await new ChatGptBrowserDiagnostics("trace_png_survives", root).capture(page, "turn-failed");

    const json = JSON.parse(readFileSync(artifact(root, ".json"), "utf8"));
    expect(json.state).toBeNull();
    expect(json.stateError).toContain("execution context unavailable");
    expect(locatorSelectors.join(" ")).toContain("conversation-turn-");
    expect(locatorSelectors.join(" ")).toMatch(/prompt-textarea|contenteditable/);
    expect(locatorSelectors.join(" ")).toContain("dialog");
    expect(locatorSelectors.join(" ")).toMatch(/account|profile/i);
    expect(Array.isArray(screenshotOptions?.mask)).toBe(true);
    expect((screenshotOptions?.mask as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect(readFileSync(artifact(root, ".png")).toString()).toBe("png");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("opt-in screenshot fails closed when the redaction mask cannot be built", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-diagnostic-"));
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
  try {
    process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = "1";
    let screenshotCalls = 0;
    const page = {
      evaluate: async () => diagnosticState,
      locator: () => { throw new Error("locator unavailable"); },
      screenshot: async () => { screenshotCalls += 1; return Buffer.from("unsafe"); },
    } as unknown as Page;
    await new ChatGptBrowserDiagnostics("trace_mask_failure", root).capture(page, "turn-failed");

    const json = JSON.parse(readFileSync(artifact(root, ".json"), "utf8"));
    expect(json.screenshotError).toContain("locator unavailable");
    expect(screenshotCalls).toBe(0);
    expect(() => artifact(root, ".png")).toThrow("missing diagnostic .png");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scopes diagnostic capture to the bound assistant turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-diagnostic-"));
  try {
    let evaluateArgument: unknown;
    const page = {
      evaluate: async (_callback: unknown, argument: unknown) => {
        evaluateArgument = argument;
        return diagnosticState;
      },
      screenshot: async () => Buffer.from("png"),
    } as unknown as Page;
    const diagnostics = new ChatGptBrowserDiagnostics("trace_bound_turn", root);
    diagnostics.bindAssistantTurn({ id: "conversation-turn-9", ordinal: 3, generation: 1 });
    await diagnostics.capture(page, "bound-turn");

    expect(evaluateArgument).toMatchObject({
      binding: { id: "conversation-turn-9", ordinal: 3, generation: 1 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
