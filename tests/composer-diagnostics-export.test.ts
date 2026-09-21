import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptPromptInsertionMetrics } from "../src/adapters/chatgpt-web/prompt-insertion-metrics";
import { planChatGptPromptInsertion } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { chatGptPromptAttachmentMismatch } from "../src/adapters/chatgpt-web/prompt-caret";

const require = createRequire(import.meta.url);
const { createLogger, exportSanitizedLogs } = require("../launcher/electron/logging.cjs");

test("composer diagnostics survive the production Activity/export route without reversible content", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-composer-export-"));
  const filePath = join(root, "activity.jsonl");
  const destinationPath = join(root, "safe.jsonl");
  const secret = "INERT_FIXTURE_DO_NOT_EXPORT";
  const text = `**${secret}**\n`;
  try {
    const logger = createLogger({ filePath });
    const metrics = new ChatGptPromptInsertionMetrics(planChatGptPromptInsertion(text), snapshot => {
      logger.info("runtime.stdout", { message: `[chatgpt-web] browser turn safe_trace composer=${JSON.stringify(snapshot)}` });
    });
    await metrics.run("insert", async () => {
      metrics.editStarted(); metrics.editSettled({ result: true, attempts: 1, accepted: 1 });
      metrics.chunk(); metrics.inserted(text.length);
    });
    metrics.finish();
    const failure = chatGptPromptAttachmentMismatch("ChatGPT composer text mismatch", text, `${text}\n`);
    logger.error("runtime.stderr", { message: failure.message });
    expect(exportSanitizedLogs({ filePath, destinationPath })).toBe(4);
    const safe = readFileSync(destinationPath, "utf8");
    expect(safe).not.toContain(secret);
    expect(safe).not.toContain("U+0049");
    expect(safe).not.toContain("expectedCodePoints");
    expect(safe).not.toContain("expectedText");
    expect(safe).toContain("nativeEditAttempts");
    expect(safe).toContain("single_lf_insertion");
    expect(safe).toContain("guarded-chunked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
