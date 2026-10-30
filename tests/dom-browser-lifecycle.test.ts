import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { readdirSync } from "node:fs";
import * as fsSync from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { launchDomBrowser } from "./support/dom-browser";

const profiles = () => readdirSync(tmpdir()).filter(name => name.startsWith("codex-dom-browser-")).sort();

test.each(["CDP close", "disconnect", "child exit"])("DOM cleanup bounds silent %s and escalates only its owned child", async phase => {
  const before = profiles();
  let finishCdp!: () => void;
  let finishExit!: (code: number) => void;
  const cdp = new Promise<void>(resolve => { finishCdp = resolve; });
  const exited = new Promise<number>(resolve => { finishExit = resolve; });
  const signals: string[] = [];
  let disconnects = 0;
  let ownedProfile: string | undefined;
  const child = { exitCode: null as number | null, exited, kill(signal: string) {
    signals.push(signal);
    if (signal === "SIGKILL" && phase !== "child exit") { child.exitCode = 0; finishExit(0); }
  } };
  const fakeBrowser = { isConnected: () => true,
    newBrowserCDPSession: async () => ({ send: () => phase === "CDP close" ? cdp : Promise.resolve() }),
    close: async () => { disconnects += 1; if (phase === "disconnect") await cdp; },
  } as unknown as Browser;
  const read = fsSync.readFileSync;
  const endpoint = spyOn(fsSync, "readFileSync").mockImplementation(((path: unknown, ...args: unknown[]) =>
    String(path).endsWith("DevToolsActivePort") ? "1234\n" : (read as Function)(path, ...args)) as typeof read);
  const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    ownedProfile = command.find(arg => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    return child;
  }) as typeof Bun.spawn);
  const connect = spyOn(chromium, "connectOverCDP").mockResolvedValue(fakeBrowser);
  let close: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const browser = await launchDomBrowser("test-owned-fake-browser");
    close = browser.close().then(() => undefined, error => error);
    const failure = await Promise.race([close, new Promise(resolve => {
      timer = setTimeout(() => resolve("cleanup never settled"), 4_000);
    })]);
    expect(failure).toBeInstanceOf(Error);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(disconnects).toBe(1);
    if (phase === "child exit") {
      expect((failure as Error).message).toContain("forced termination");
      expect(profiles()).toContain(basename(ownedProfile!));
    } else expect(profiles()).toEqual(before);
  } finally {
    clearTimeout(timer);
    finishCdp(); child.exitCode = 0; finishExit(0);
    await close;
    endpoint.mockRestore(); spawn.mockRestore(); connect.mockRestore();
    if (ownedProfile) {
      expect(dirname(resolve(ownedProfile))).toBe(resolve(tmpdir()));
      expect(basename(ownedProfile)).toStartWith("codex-dom-browser-");
      await fs.rm(ownedProfile, { recursive: true, force: true });
    }
  }
}, 8_000);

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
