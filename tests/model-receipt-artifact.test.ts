import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordChatGptMetadataDiagnostic } from "../src/adapters/chatgpt-web/model-receipt-artifact";
import { assertChatGptModelReceiptDiagnostic, ChatGptModelReceiptCollector, type ChatGptModelReceiptDiagnostic } from "../src/adapters/chatgpt-web/model-receipt";

function diagnostic(): ChatGptModelReceiptDiagnostic {
  const collector = new ChatGptModelReceiptCollector();
  const message = { id: "PRIVATE_MESSAGE_ID", author: { role: "assistant" }, metadata: {
    resolved_model_slug: `gpt-${"Z".repeat(100)}`,
    requested_model_slug: `gpt-${"Y".repeat(100)}`,
  }, content: { parts: ["PRIVATE_ANSWER"] } };
  for (let index = 0; index < 32; index += 1) collector.consumeJson({ message, data: { v: Array.from({ length: 6 }, () => ({ message })) } });
  return {
    kind: "chatgpt_model_receipt_diagnostic", version: 1, traceId: "artifact_fixture", physicalSend: 1,
    responseAttempt: 1, provenance: "initial", outcome: "unavailable", reason: "missing_resolved_model",
    ownedRequests: 1, cdpCaptures: 0, terminalCaptures: 1,
    parser: { page: { status: "unavailable", parsedEvents: 32, decodedBytes: 0 }, totalParsedEvents: 32, totalDecodedBytes: 0,
      traces: [{ source: "page", transport: "page_tee", terminal: "reader_end", ...collector.diagnosticTrace() }] },
  };
}

test.skipIf(process.platform === "win32")("complete sanitized traces survive the launcher string limit in private hash-verifiable artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "metadata-artifact-"));
  try {
    const original = diagnostic();
    expect(JSON.stringify(original).length).toBeGreaterThan(16_384);
    const brief = recordChatGptMetadataDiagnostic(original, root, true);
    assertChatGptModelReceiptDiagnostic(brief);
    expect(JSON.stringify(brief).length).toBeLessThan(16_384);
    expect(brief.parser?.traces).toBeUndefined();
    expect(brief.recording?.status).toBe("written");
    if (brief.recording?.status !== "written") throw new Error("Missing recording");
    const path = join(root, brief.recording.file);
    const bytes = readFileSync(path);
    expect(bytes.length).toBe(brief.recording.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(brief.recording.sha256);
    expect(JSON.parse(bytes.toString())).toEqual(original);
    expect(bytes.toString()).not.toContain("PRIVATE_ANSWER");
    expect(bytes.toString()).not.toContain("PRIVATE_MESSAGE_ID");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    recordChatGptMetadataDiagnostic(original, root, true);
    expect(readdirSync(root)).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recording failure is isolated and unsafe diagnostic fields are rejected before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "metadata-artifact-failure-"));
  try {
    chmodSync(root, 0o755);
    expect(recordChatGptMetadataDiagnostic(diagnostic(), root, true).recording).toEqual({ status: "unavailable", reason: process.platform === "win32" ? "unsupported_platform" : "io_failed" });
    expect(readdirSync(root)).toHaveLength(0);
    expect(() => recordChatGptMetadataDiagnostic({ ...diagnostic(), prompt: "PRIVATE_PROMPT" } as never, root)).toThrow();
    expect(readdirSync(root)).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("diagnostic storage saturation stops new writes without deleting retained evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "metadata-artifact-capacity-"));
  try {
    for (let i = 0; i < 256; i++) writeFileSync(join(root, `metadata-existing-${i}.json`), "retained", { mode: 0o600 });
    const brief = recordChatGptMetadataDiagnostic(diagnostic(), root, true);
    expect(brief.recording).toEqual({ status: "unavailable", reason: "bounded" });
    expect(readdirSync(root)).toHaveLength(256);
    expect(readFileSync(join(root, "metadata-existing-0.json"), "utf8")).toBe("retained");
    expect(brief.outcome).toBe("unavailable");
    expect(brief.parser?.traces).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary receipt diagnostics discard detailed traces without recording artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "metadata-no-consent-"));
  const target = join(root, "must-not-exist");
  try {
    const brief = recordChatGptMetadataDiagnostic(diagnostic(), target);
    assertChatGptModelReceiptDiagnostic(brief);
    expect(brief.parser?.traces).toBeUndefined();
    expect(brief.recording).toBeUndefined();
    expect(readdirSync(root)).toHaveLength(0);
    expect(brief.parser?.totalParsedEvents).toBe(32);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
