import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertWebContractCooldown,
  captureWebContract,
  deriveWebContractCapabilities,
  requestWebContractTurn,
  responseHasFinalProjection,
  WEB_CONTRACT_COOLDOWN_MS,
  webContractBrowserIsIdle,
} from "../scripts/lifecycle-smoke/web-contract-core";

describe("lightweight Web contract smoke", () => {
  test("refreshes once for connector verification before inspecting the hydrated surface", () => {
    const script = readFileSync(new URL("../scripts/lifecycle-smoke/web-contract.ts", import.meta.url), "utf8");
    const verifyAt = script.indexOf("const connectorVerified = await verifyLauncherBrowserConnector");
    const inspectAt = script.indexOf("const inspected = await inspectLauncherBrowserHost");
    const cooldownAt = script.indexOf("writeFileSync(lastRunPath");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(cooldownAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(cooldownAt);
    expect(inspectAt).toBeGreaterThan(verifyAt);
    expect(script).toContain("detectCapabilities: false");
    expect(script).toContain("detectChatGptAccountCapabilities(connection.page)");
  });

  test("captures only allowlisted semantic capabilities", () => {
    const captured = captureWebContract({
      authenticated: true,
      temporary: true,
      composer: true,
      effort: true,
      connector: true,
      submitted: true,
      finalProjection: true,
      idle: true,
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
      submitted: true,
      finalProjection: true,
      idle: true,
    });
    expect(JSON.stringify(captured)).not.toContain("private");
    expect(JSON.stringify(captured)).not.toContain("secret");
  });

  test("derives every capability from observed session, connector, response, and idle evidence", () => {
    expect(deriveWebContractCapabilities({
      session: { authenticated: true, temporary: true, composer: true, solAvailable: true },
      connectorVerified: false,
      responseAccepted: true,
      finalProjection: false,
      idle: true,
    })).toEqual({
      authenticated: true,
      temporary: true,
      composer: true,
      effort: true,
      connector: false,
      submitted: true,
      finalProjection: false,
      idle: true,
    });
  });

  test("allows unrelated HTTP turns but rejects a parallel Web turn", () => {
    expect(webContractBrowserIsIdle({ active_http_turns: 4, active_browser_turns: 0 })).toBeTrue();
    expect(webContractBrowserIsIdle({ active_http_turns: 0, active_browser_turns: 1 })).toBeFalse();
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
});
