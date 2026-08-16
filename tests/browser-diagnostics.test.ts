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

function artifact(root: string, extension: string): string {
  const directory = join(root, readdirSync(root)[0]!);
  const name = readdirSync(directory).find(value => value.endsWith(extension));
  if (!name) throw new Error(`missing diagnostic ${extension}`);
  return join(directory, name);
}

test("preserves DOM diagnostic JSON when screenshot capture times out", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-diagnostic-"));
  try {
    const page = {
      evaluate: async () => diagnosticState,
      screenshot: async () => { throw new Error("screenshot timeout"); },
    } as unknown as Page;
    await new ChatGptBrowserDiagnostics("trace_json_survives", root).capture(page, "turn-failed");

    const json = JSON.parse(readFileSync(artifact(root, ".json"), "utf8"));
    expect(json.state).toEqual(diagnosticState);
    expect(json.screenshotError).toContain("screenshot timeout");
    expect(() => artifact(root, ".png")).toThrow("missing diagnostic .png");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves screenshot and error envelope when DOM evaluation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-browser-diagnostic-"));
  try {
    const page = {
      evaluate: async () => { throw new Error("execution context unavailable"); },
      screenshot: async () => Buffer.from("png"),
    } as unknown as Page;
    await new ChatGptBrowserDiagnostics("trace_png_survives", root).capture(page, "turn-failed");

    const json = JSON.parse(readFileSync(artifact(root, ".json"), "utf8"));
    expect(json.state).toBeNull();
    expect(json.stateError).toContain("execution context unavailable");
    expect(readFileSync(artifact(root, ".png")).toString()).toBe("png");
  } finally {
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
