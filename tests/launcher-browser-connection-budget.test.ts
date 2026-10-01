import { expect, test } from "bun:test";
import { runLauncherBrowserConnection } from "../src/launcher-browser-connection";

test("launcher browser connection stages share one wall-clock timeout", async () => {
  let now = 1_000;
  const budgets: [string, number][] = [];
  const result = await runLauncherBrowserConnection(5_000, {
    ready: async budget => { budgets.push(["ready", budget]); now += 1_000; },
    connect: async budget => { budgets.push(["connect", budget]); now += 1_500; return "browser"; },
    select: async (browser, budget) => { budgets.push([`select:${browser}`, budget]); return "page"; },
    close: async () => { throw new Error("successful connection must stay open"); },
  }, () => now);
  expect(result).toBe("page");
  expect(budgets).toEqual([["ready", 5_000], ["connect", 4_000], ["select:browser", 2_500]]);
});

test("launcher browser connection closes an acquired browser when its shared deadline expires", async () => {
  let now = 0;
  let closed = 0;
  let selected = 0;
  await expect(runLauncherBrowserConnection(5_000, {
    ready: async () => {},
    connect: async () => { now = 5_000; return "browser"; },
    select: async () => { selected += 1; return "page"; },
    close: async browser => { expect(browser).toBe("browser"); closed += 1; },
  }, () => now)).rejects.toThrow("connection timed out after 5000ms");
  expect({ selected, closed }).toEqual({ selected: 0, closed: 1 });
});

test("launcher browser connection rejects and closes when selection returns after its deadline", async () => {
  let now = 0;
  let closed = 0;
  await expect(runLauncherBrowserConnection(5_000, {
    ready: async () => {},
    connect: async () => "browser",
    select: async () => { now = 5_001; return "page"; },
    close: async browser => { expect(browser).toBe("browser"); closed += 1; },
  }, () => now)).rejects.toThrow("connection timed out after 5000ms");
  expect(closed).toBe(1);
});
