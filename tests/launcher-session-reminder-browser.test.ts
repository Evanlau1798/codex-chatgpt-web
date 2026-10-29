import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("session reminder stays above native browser views without changing their size or reloading them", async () => {
  const root = mkdtempSync(join(tmpdir(), "launcher-reminder-layer-"));
  const log = join(root, "fixture.log");
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const build = Bun.spawnSync([process.execPath, "run", "build:renderer", "--outDir", root], {
      cwd: resolve(import.meta.dir, "../launcher"), stdout: "pipe", stderr: "pipe",
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    app = await _electron.launch({ executablePath: process.env.LAUNCHER_TEST_ELECTRON,
      args: [resolve(import.meta.dir, "../launcher/tests/fixtures/session-reminder.cjs"), `--user-data-dir=${join(root, "profile")}`, `--renderer=${join(root, "index.html")}`, `--fixture-log=${log}`],
      env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>,
    });
    const wait = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(30); }
      throw new Error("Session reminder fixture did not reach the expected state");
    };
    await wait(() => app!.evaluate(() => Boolean((globalThis as any).sessionReminderFixture?.host.boundsReady)));
    const bounds = () => app!.evaluate(() => (globalThis as any).sessionReminderFixture.host.view.getBounds());
    const before = await bounds();
    await app.evaluate(() => {
      const fixture = (globalThis as any).sessionReminderFixture;
      fixture.state.sessionRefreshReminderAt = new Date(0).toISOString();
      fixture.host.window.webContents.send("launcher:state-changed", fixture.state);
    });
    await wait(() => app!.evaluate(() => Boolean((globalThis as any).sessionReminderFixture.reminder.height)));
    expect(await bounds()).toEqual(before);
    expect(await app.evaluate(() => {
      const { host, reminder } = (globalThis as any).sessionReminderFixture;
      const children = host.window.contentView.children;
      return children.indexOf(reminder.view) > children.indexOf(host.view);
    })).toBe(true);
    const pages = app.context().pages();
    const notice = (await Promise.all(pages.map(async page => ({ page,
      notice: await page.evaluate(() => Boolean((window as any).codexSessionReminder)),
    })))).find(value => value.notice)!.page;
    await notice.locator(".session-refresh-reminder").waitFor({ state: "visible" });
    const oldGuest = app.context().pages().find(page => page.url().startsWith("data:"))!;
    await oldGuest.getByRole("button", { name: "Test browser interaction" }).click();
    expect(await oldGuest.getByRole("button").innerText()).toBe("Clicked");
    await app.evaluate(async () => {
      const { host, reminder } = (globalThis as any).sessionReminderFixture;
      host.state = { zoomFactor: 1 };
      host.syncPowerSaveBlocker = () => {};
      host.bindShellZoomShortcuts = () => {};
      host.bindTurnContents = () => {};
      const next = await host.createTurnTab("fixture-turn", process.pid);
      host.selectedTabId = next.id;
      host.syncViewVisibility();
      if (host.window.contentView.children.at(-1) !== reminder.view) throw new Error("New browser view covered the reminder");
      host.removeTurnTab(next, true);
      if (host.turnTabs.size || host.window.contentView.children.includes(next.interactionShield)) {
        throw new Error("Turn cleanup left browser ownership or its shield behind");
      }
    });
    await app.evaluate(() => {
      const { host } = (globalThis as any).sessionReminderFixture;
      host.window.setContentSize(720, 600);
      host.window.webContents.setZoomFactor(1.25);
    });
    await wait(() => app!.evaluate(() => {
      const { reminder } = (globalThis as any).sessionReminderFixture;
      const rect = reminder.view.getBounds();
      return rect.width === 558 && rect.y === 65;
    }));
    // Let the existing sidebar transition finish before comparing browser bounds.
    await Bun.sleep(600);
    const beforeDismiss = await bounds();
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click().catch(error => {
      // Dismiss destroys this exact renderer; native state below proves the action.
      if (!notice.isClosed()) throw error;
    });
    await wait(() => app!.evaluate(() => (globalThis as any).sessionReminderFixture.reminder.view === null));
    expect(await bounds()).toEqual(beforeDismiss);
    expect(await app.evaluate(() => {
      const fixture = (globalThis as any).sessionReminderFixture;
      return { actions: fixture.actions, loads: fixture.loads };
    })).toEqual({ actions: ["dismiss"], loads: 0 });
  } finally {
    try { await app?.close(); }
    finally {
      const diagnostics = existsSync(log) ? readFileSync(log, "utf8") : "";
      console.error(diagnostics);
      rmSync(root, { recursive: true, force: true });
      expect(diagnostics).not.toContain("fatal:");
    }
  }
}, 30_000);
