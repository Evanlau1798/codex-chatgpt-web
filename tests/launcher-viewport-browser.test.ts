import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("finishing another Electron tab preserves the open model picker and viewport", async () => {
  const userData = mkdtempSync(join(tmpdir(), "launcher-viewport-"));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/viewport.cjs"), `--user-data-dir=${userData}`], env,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!await app.evaluate(() => Boolean((globalThis as any).viewportFixture)) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(await app.evaluate(() => Boolean((globalThis as any).viewportFixture))).toBe(true);
    const page = app.context().pages().find(page => page.url().endsWith("#first"))!;
    expect(page).toBeDefined();
    const dimensions = () => page.evaluate(() => [innerWidth, innerHeight]);
    // Include the launcher's user zoom: native and emulated dimensions must agree in CSS pixels.
    for (const zoom of [1, 1.25]) {
      await app.evaluate((_, zoom) => {
        const host = (globalThis as any).viewportFixture;
        host.turnTabs.get("first").view.webContents.setZoomFactor(zoom);
        host.selectedTabId = "first";
        host.syncViewVisibility();
      }, zoom);
      // Hydrate the fixture's first visible frame before testing a subsequent tab transition.
      await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await app.evaluate(() => {
        const host = (globalThis as any).viewportFixture;
        host.selectedTabId = "home";
        host.syncViewVisibility();
      });
      await page.waitForFunction(zoom => {
        return innerWidth === Math.round(840 / zoom) && innerHeight === Math.round(656 / zoom)
          && performance.now() - (window as any).lastResizeAt >= 200;
      }, zoom, { polling: 50, timeout: 5_000 });
      const before = await dimensions();
      const resizeCount = await page.evaluate(() => (window as any).resizes.length);
      // Open the synthetic menu without relying on Windows hit-testing outside the native window.
      await page.getByRole("button", { name: "Models", exact: true }).dispatchEvent("click");
      expect(await page.getByRole("menu").isVisible()).toBe(true);
      await app.evaluate(() => {
        const host = (globalThis as any).viewportFixture;
        const second = host.turnTabs.get("second");
        if (second) {
          host.selectedTabId = second.id;
          host.removeTurnTab(second, false);
        } else host.selectTab("first");
      });
      await page.waitForTimeout(200);
      expect(await dimensions()).toEqual(before);
      expect(await page.evaluate(() => (window as any).resizes.length)).toBe(resizeCount);
      expect(await page.getByRole("menu").isVisible()).toBe(true);
      await page.getByRole("menuitemradio", { name: "GPT-5.6 Sol" }).click({ timeout: 1_000 });
      expect(await page.getByRole("menuitemradio").getAttribute("aria-checked")).toBe("true");
      for (const show of [false, true]) {
        await app.evaluate((_, show) => {
          const host = (globalThis as any).viewportFixture;
          if (show) host.window.showInactive();
          else host.window.hide();
          host.syncViewVisibility();
        }, show);
        await page.waitForTimeout(200);
        expect(await dimensions()).toEqual(before);
        expect(await page.getByRole("menu").isVisible()).toBe(true);
      }
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("finishing work leaves a fresh preparing standby picker offscreen", async () => {
  const userData = mkdtempSync(join(tmpdir(), "launcher-standby-viewport-"));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/viewport.cjs"), `--user-data-dir=${userData}`], env,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!await app.evaluate(() => Boolean((globalThis as any).viewportFixture)) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(await app.evaluate(() => Boolean((globalThis as any).viewportFixture))).toBe(true);
    const page = app.context().pages().find(page => page.url().endsWith("#first"))!;
    await app.evaluate(() => {
      const tab = (globalThis as any).viewportFixture.turnTabs.get("first");
      tab.startupPreparation = true;
      tab.startupReady = false;
    });
    // Settle initial emulation without ever presenting the fresh standby.
    await page.waitForFunction(() => (window as any).resizes.length > 0
      && innerWidth === 840 && innerHeight === 656
      && performance.now() - (window as any).lastResizeAt >= 200,
    undefined, { polling: 50, timeout: 5_000 });
    await page.getByRole("button", { name: "Models", exact: true }).dispatchEvent("click");
    const before = await page.evaluate(() => ({ dimensions: [innerWidth, innerHeight], resizes: (window as any).resizes.length }));
    await app.evaluate(() => {
      const host = (globalThis as any).viewportFixture;
      host.removeTurnTab(host.turnTabs.get("second"), false);
    });
    expect(await app.evaluate(() => (globalThis as any).viewportFixture.selectedTabId)).toBe("home");
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => ({ dimensions: [innerWidth, innerHeight], resizes: (window as any).resizes.length }))).toEqual(before);
    expect(await page.getByRole("menu").isVisible()).toBe(true);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}, 30_000);
