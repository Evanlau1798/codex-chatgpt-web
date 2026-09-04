import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as setup from "../src/setup";
import { runDevCommand } from "../src/dev-chat/cli";

async function fixture(run: (invoke: (flags: string[]) => Promise<void>, captured: setup.SetupOptions[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-cli-"));
  const keys = ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME", "CODEX_WEB_GPT_DEV_HOME"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const captured: setup.SetupOptions[] = [];
  const stub = spyOn(setup, "setupDevProfile").mockImplementation(async options => {
    captured.push(options);
    return { mode: options.mode, configPath: join(root, "config.json"), tunnelReady: false, connectorSetupRequired: true };
  });
  try {
    await run(async flags => {
      process.env.CODEX_CHATGPT_WEB_HOME = join(root, "production");
      process.env.CODEX_WEB_GPT_DEV_HOME = join(root, "development");
      await runDevCommand(["setup", "--full", "--zero-risk-browser-interaction", "--acknowledge-unofficial", ...flags]);
    }, captured);
  } finally {
    stub.mockRestore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("DEV CLI forwards explicit Pro and tool-approval flags from launcher setup", async () => {
  await fixture(async (invoke, captured) => {
    await invoke(["--zero-risk-pro", "--auto-approve-tool-calls"]);
    await invoke(["--zero-risk-default"]);
    expect(captured[0]).toMatchObject({ browserInteractionMode: "manual", zeroRiskProEnabled: true, autoApproveToolCalls: true });
    expect(captured[1]).toMatchObject({ zeroRiskProEnabled: false });
  });
});

test("DEV CLI rejects contradictory Pro flags before dispatch", async () => {
  await fixture(async (invoke, captured) => {
    await expect(invoke(["--zero-risk-pro", "--zero-risk-default"])).rejects.toThrow("Choose at most one Zero Risk model profile");
    expect(captured).toHaveLength(0);
  });
});
