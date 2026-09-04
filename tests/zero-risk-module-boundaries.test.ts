import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("v5 additions keep the previously bounded host, login and config modules under 500 lines", () => {
  for (const file of ["config", "browser-login", "launcher-browser-host"]) {
    const source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
    expect(source.trimEnd().split(/\r?\n/).length, file).toBeLessThanOrEqual(500);
  }
});
