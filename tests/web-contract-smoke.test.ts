import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertWebContractCooldown,
  assertWebContractRuntimeVersion,
  captureWebContract,
  deriveWebContractCapabilities,
  retainedRefreshTabId,
  requestWebContractTurn,
  responseHasFinalProjection,
  WEB_CONTRACT_INITIAL_SYSTEM,
  WEB_CONTRACT_REFRESH_SYSTEM,
  WEB_CONTRACT_COOLDOWN_MS,
  WEB_CONTRACT_PROBE_TIMEOUT_MS,
  WEB_CONTRACT_TURN_TIMEOUT_MS,
  webContractBrowserIsIdle,
} from "../scripts/lifecycle-smoke/web-contract-core";
import {
  markdownRestorationProbeText,
  MARKDOWN_RESTORATION_PROBE_CHARS,
  STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS,
  structuredMarkdownRestorationProbeText,
} from "../scripts/lifecycle-smoke/markdown-restoration-probe";

describe("lightweight Web contract smoke", () => {
  test("keeps the first live turn inline and moves the large revision to retained refresh", () => {
    expect(WEB_CONTRACT_INITIAL_SYSTEM.length).toBeLessThan(512);
    expect(WEB_CONTRACT_REFRESH_SYSTEM.length).toBeGreaterThan(20_000);
    expect(WEB_CONTRACT_REFRESH_SYSTEM).not.toBe(WEB_CONTRACT_INITIAL_SYSTEM);
  });

  test("uses the requested Medium route without model fallback", () => {
    const script = readFileSync(
      new URL("../scripts/lifecycle-smoke/web-contract.ts", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(script).toContain('model: "chatgpt-web/medium"');
    expect(script).toContain('reasoning: { effort: "medium" }');
    expect(script).not.toContain("session.proAvailable !== true");
    expect(script).not.toContain('model: "chatgpt-web/high"');
    expect(script).not.toContain('model: "chatgpt-web/extra-high"');
  });
  test("keeps account-bound probes on its leased turn surface", () => {
    const script = readFileSync(
      new URL("../scripts/lifecycle-smoke/web-contract.ts", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const cooldownAt = script.indexOf("writeFileSync(lastRunPath");
    const leaseAt = script.indexOf('phase: "start"');
    const probeAt = script.indexOf("runMarkdownRestorationProbe(");
    expect(cooldownAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(cooldownAt);
    expect(probeAt).toBeGreaterThan(leaseAt);
    expect(script).not.toContain("verifyLauncherBrowserConnector");
    expect(script).not.toContain("inspectLauncherBrowserHost");
    expect(script).toContain("detectChatGptAccountCapabilities(connection.page)");
    expect(script).toContain("runMarkdownRestorationProbe(");
    expect(script).toContain("runMarkdownRestorationProbe(connection.page, config.appName, signal)");
    expect(script).toContain("connectorVerified = true");
    expect(script).toContain("authenticated: true");
    expect(script).toContain("composer: true");
    expect(script).toContain('config.browserInteractionMode !== "automatic"');
    expect(script).toContain('phase: "start"');
    expect(script).toContain("lease.surfaceId");
    expect(script).toContain('phase: "end"');
  });

  test("uses the incident-sized Markdown insertion probe without sending its contents", () => {
    const prompt = markdownRestorationProbeText();
    const structuredPrompt = structuredMarkdownRestorationProbeText();
    const probe = readFileSync(
      new URL("../scripts/lifecycle-smoke/markdown-restoration-probe.ts", import.meta.url),
      "utf8",
    );
    expect(MARKDOWN_RESTORATION_PROBE_CHARS).toBe(96_000);
    expect(prompt).toHaveLength(MARKDOWN_RESTORATION_PROBE_CHARS);
    expect(prompt[16_000]).toBe(" ");
    expect(prompt).toContain('{"key":[1,2,3]}');
    expect(STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS).toBe(13_958);
    expect(structuredPrompt).toHaveLength(STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS);
    expect(structuredPrompt).toContain("```json\n");
    expect(structuredPrompt).toContain("<environment_context>\n");
    expect(probe).toContain("finally {");
    expect(probe).toContain("for (let run = 0; run < 3; run += 1)");
    expect(probe).toContain("durationMs >= 10_000");
    expect(probe).toContain("medianMs >= 5_000");
    expect(probe).toContain("WEB_CONTRACT_MARKDOWN_PROBE_TIMINGS");
    expect(probe).toContain("WEB_CONTRACT_STRUCTURED_MARKDOWN_PROBE_OK");
    const structuredAt = probe.indexOf("const structuredPrompt = structuredMarkdownRestorationProbeText()");
    const structuredInsertAt = probe.indexOf("await insertChatGptComposerPlainText(composer, structuredPrompt, abortSignal)");
    const structuredReadbackAt = probe.indexOf("await waitForText(composer, structuredPrompt, abortSignal)");
    const structuredConnectorAt = probe.indexOf("JSON.stringify(await connectorState(composer)) !== JSON.stringify(structuredConnectors)");
    const structuredNoTurnAt = probe.indexOf("Structured Markdown restoration probe unexpectedly submitted a turn");
    const structuredSuccessAt = probe.indexOf("WEB_CONTRACT_STRUCTURED_MARKDOWN_PROBE_OK");
    expect([
      structuredAt,
      structuredInsertAt,
      structuredReadbackAt,
      structuredConnectorAt,
      structuredNoTurnAt,
      structuredSuccessAt,
    ].every((position, index, positions) => position >= 0 && (index === 0 || position > positions[index - 1]!)))
      .toBeTrue();
    expect(probe).toContain("clearChatGptComposerInput(composer)");
    expect(probe.indexOf("await clearChatGptComposerInput(composer)"))
      .toBeLessThan(probe.indexOf("composer = await selectConnector(page, appName)"));
    expect(probe.indexOf("await composer.focus()"))
      .toBeLessThan(probe.indexOf("await insertChatGptComposerPlainText(composer, chunk, abortSignal)"));
    expect(probe).not.toContain("page.keyboard.insertText(chunk)");
    expect(probe).toContain("CHATGPT_USER_TURN_SELECTOR");
    expect(probe).toContain('pressSequentially("@codex"');
    expect(probe).toContain("MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS");
    expect(probe).toContain("unexpectedly submitted a turn");
    expect(probe).toContain("could not clear connector state");
    expect(probe).toContain("cleanup left submittable content");
  });

  test("captures only allowlisted semantic capabilities", () => {
    const captured = captureWebContract({
      authenticated: true,
      temporary: true,
      composer: true,
      effort: true,
      connector: true,
      markdownRestoration: true,
      retainedRefresh: true,
      submitted: true,
      finalProjection: true,
      browserIdle: true,
      rawHtml: "<main>private response</main>",
      account: "private@example.test",
      url: "https://chatgpt.com/?token=secret",
      response: "private response",
    });
    expect(captured).toEqual({
      authenticated: true,
      temporary: true,
      composer: true,
      effort: true,
      connector: true,
      markdownRestoration: true,
      retainedRefresh: true,
      submitted: true,
      finalProjection: true,
      browserIdle: true,
    });
    expect(JSON.stringify(captured)).not.toContain("private");
    expect(JSON.stringify(captured)).not.toContain("secret");
  });

  test("derives every capability from observed session, connector, response, and idle evidence", () => {
    expect(deriveWebContractCapabilities({
      session: { authenticated: true, temporary: true, composer: true, solAvailable: true },
      connectorVerified: false,
      markdownRestoration: true,
      retainedRefresh: false,
      responseAccepted: true,
      finalProjection: false,
      browserIdle: true,
    })).toEqual({
      authenticated: true,
      temporary: true,
      composer: true,
      effort: true,
      connector: false,
      markdownRestoration: true,
      retainedRefresh: false,
      submitted: true,
      finalProjection: false,
      browserIdle: true,
    });
  });

  test("requires the second live turn to reuse the first retained tab", () => {
    expect(retainedRefreshTabId([
      { event: "browser.tab_retained", detail: { tabId: "tab-a" } },
      { event: "browser.tab_reused", detail: { tabId: "tab-a" } },
    ])).toBe("tab-a");
    expect(() => retainedRefreshTabId([
      { event: "browser.tab_retained", detail: { tabId: "tab-a" } },
      { event: "browser.tab_reused", detail: { tabId: "tab-b" } },
    ])).toThrow("did not reuse");
  });

  test("allows unrelated HTTP turns but rejects a parallel Web turn", () => {
    expect(webContractBrowserIsIdle({ active_http_turns: 4, active_browser_turns: 0 })).toBeTrue();
    expect(webContractBrowserIsIdle({ active_http_turns: 0, active_browser_turns: 1 })).toBeFalse();
    for (const invalid of [undefined, null, "", "0", -1, 0.5]) {
      expect(webContractBrowserIsIdle({ active_browser_turns: invalid })).toBeFalse();
    }
  });

  test("accepts any non-empty final projection without depending on model wording", () => {
    expect(responseHasFinalProjection({
      output: [{ content: [{ type: "output_text", text: "A short completed response." }] }],
    })).toBeTrue();
    expect(responseHasFinalProjection({
      output: [{ content: [{ type: "output_text", text: "   " }] }],
    })).toBeFalse();
  });

  test("stops after the first 429 response", async () => {
    let calls = 0;
    const result = await requestWebContractTurn(async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }, new Request("http://127.0.0.1/v1/responses"));
    expect(result).toEqual({ status: "account-blocked", httpStatus: 429 });
    expect(calls).toBe(1);
  });

  test("treats a structured verification limit as account-blocked", async () => {
    const result = await requestWebContractTurn(
      async () => Response.json({ error: { code: "verification_limit" } }),
      new Request("http://127.0.0.1/v1/responses"),
    );
    expect(result).toEqual({ status: "account-blocked", httpStatus: 429 });
  });

  test("enforces a two-minute manual rerun interval", () => {
    expect(WEB_CONTRACT_COOLDOWN_MS).toBe(120_000);
    expect(() => assertWebContractCooldown(1_000, 120_999)).toThrow("two-minute cooldown");
    expect(() => assertWebContractCooldown(1_000, 121_000)).not.toThrow();
  });

  test("requires the live daemon to match the exact release candidate version", () => {
    expect(assertWebContractRuntimeVersion(
      { version: "4.0.8-Enhanced.1", pid: 1234 },
      "4.0.8-Enhanced.1",
    )).toBe(1234);
    expect(() => assertWebContractRuntimeVersion({ version: "4.0.7-Enhanced.3" }, "4.0.8-Enhanced.1"))
      .toThrow("candidate version");
    expect(() => assertWebContractRuntimeVersion({}, "4.0.8-Enhanced.1"))
      .toThrow("candidate version");
    expect(() => assertWebContractRuntimeVersion({ version: "4.0.8-Enhanced.1" }, "4.0.8-Enhanced.1"))
      .toThrow("runtime process");
    expect(() => assertWebContractRuntimeVersion(
      { version: "4.0.8-Enhanced.1", pid: 5678 },
      "4.0.8-Enhanced.1",
      1234,
    )).toThrow("changed process");
  });

  test("checks the same live runtime process before and after the account-bound turn", () => {
    const script = readFileSync(
      new URL("../scripts/lifecycle-smoke/web-contract.ts", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(script.match(/assertWebContractRuntimeVersion\(/g)).toHaveLength(2);
    expect(script).toContain("runtimePid");
    expect(WEB_CONTRACT_TURN_TIMEOUT_MS).toBe(180_000);
    expect(WEB_CONTRACT_PROBE_TIMEOUT_MS).toBe(300_000);
    expect(script).toMatch(/withDeadline\(\s*WEB_CONTRACT_PROBE_TIMEOUT_MS,/);
    expect(script).toContain("withDeadline(WEB_CONTRACT_TURN_TIMEOUT_MS");
    expect(script).toContain("clearTimeout(timer)");
    expect(script).not.toContain("AbortSignal.timeout(");
    expect(script).toContain("**bold**, `code`, and _emphasis_");
  });
});
