import { mkdtempSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/** Test-owned CDP matches the launcher without Bun's Windows Chromium stdio pipe. */
export async function launchDomBrowser(executablePath = process.env.CHATGPT_DOM_TEST_BROWSER!): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "codex-dom-browser-"));
  let child: Bun.Subprocess | undefined;
  const cleanup = async () => {
    if (child?.exitCode === null) child.kill("SIGTERM");
    await child?.exited;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rm(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await Bun.sleep(100 * (attempt + 1));
      }
    }
  };
  try {
    child = Bun.spawn([executablePath, "--headless=new", "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
    let port = 0;
    const deadline = Date.now() + 10_000;
    while (!port && Date.now() < deadline && child.exitCode === null) {
      try { port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); }
      catch { /* The owned browser has not published its endpoint yet. */ }
      if (!port) await Bun.sleep(50);
    }
    if (!port) throw new Error("Test-owned Chromium did not publish its CDP endpoint");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const disconnect = browser.close.bind(browser);
    let closing: Promise<void> | undefined;
    browser.close = () => closing ??= (async () => {
      try {
        if (browser.isConnected()) await (await browser.newBrowserCDPSession()).send("Browser.close");
        await disconnect();
      } finally { await cleanup(); }
    })();
    return browser;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
