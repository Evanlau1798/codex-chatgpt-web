import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { launchDomBrowser } from "./support/dom-browser";

const profiles = () => readdirSync(tmpdir()).filter(name => name.startsWith("codex-dom-browser-")).sort();

test("DOM browser startup failure removes its test-owned profile", async () => {
  const before = profiles();
  const failure = await launchDomBrowser("missing-codex-dom-browser-executable")
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(profiles()).toEqual(before);
});

test("DOM browser cleanup retries a transient profile lock without losing the startup error", async () => {
  const before = profiles();
  const remove = fs.rm;
  let profile: string | undefined;
  let calls = 0;
  const locked = Object.assign(new Error("Test-owned profile is busy"), { code: "EBUSY" });
  const retry = spyOn(fs, "rm").mockImplementation(async (path, options) => {
    profile = String(path);
    if (++calls < 3) throw locked;
    await remove(path, options);
  });
  try {
    const failure = await launchDomBrowser("missing-codex-dom-browser-executable")
      .then(() => undefined, (error: unknown) => error);
    expect(calls).toBe(3);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(locked);
    expect(profiles()).toEqual(before);
  } finally {
    retry.mockRestore();
    if (profile) await remove(profile, { recursive: true, force: true });
  }
});

test("DOM browser cleanup reports persistent locks and fails immediately on other errors", async () => {
  const remove = fs.rm;
  for (const [code, expectedCalls] of [["EBUSY", 6], ["EACCES", 1]] as const) {
    let profile: string | undefined;
    let calls = 0;
    const denied = Object.assign(new Error("Test-owned cleanup failure"), { code });
    const retry = spyOn(fs, "rm").mockImplementation(async path => {
      profile = String(path);
      calls += 1;
      throw denied;
    });
    try {
      const failure = await launchDomBrowser("missing-codex-dom-browser-executable")
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toBe(denied);
      expect(calls).toBe(expectedCalls);
    } finally {
      retry.mockRestore();
      if (profile) await remove(profile, { recursive: true, force: true });
    }
  }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("DOM browser settles repeated close and removes its own profile", async () => {
  const before = profiles();
  const browser = await launchDomBrowser();
  try {
    expect(profiles().filter(name => !before.includes(name))).toHaveLength(1);
    const page = await browser.newPage();
    await page.setContent("<p>DOM_CDP_OWNERSHIP</p>");
    expect(await page.locator("p").textContent()).toBe("DOM_CDP_OWNERSHIP");
    await Promise.all([browser.close(), browser.close()]);
    expect(browser.isConnected()).toBeFalse();
    expect(profiles()).toEqual(before);
  } finally { await browser.close(); }
}, 15_000);
