import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config";
import { assertChatGptModelReceiptDiagnostic, type ChatGptModelReceiptDiagnostic } from "./model-receipt";

/** Keep complete sanitized metadata outside the launcher's 16 KiB string-log ceiling. */
export function recordChatGptMetadataDiagnostic(
  diagnostic: ChatGptModelReceiptDiagnostic,
  directory = join(getConfigDir(), "diagnostics", "model-receipts"),
  enabled = false,
): ChatGptModelReceiptDiagnostic {
  assertChatGptModelReceiptDiagnostic(diagnostic);
  if (!diagnostic.parser?.traces) return diagnostic;
  const { traces: _traces, ...parser } = diagnostic.parser;
  const brief: ChatGptModelReceiptDiagnostic = { ...diagnostic, parser };
  // Ordinary receipts need counters/identity, not replay artifacts. Drop traces
  // before logging and perform no filesystem operation without explicit consent.
  if (!enabled) return brief;
  // Do not pretend POSIX mode bits establish a private Windows ACL.
  if (process.platform === "win32") return { ...brief, recording: { status: "unavailable", reason: "unsupported_platform" } };
  const encoded = `${JSON.stringify(diagnostic)}\n`;
  const bytes = Buffer.byteLength(encoded);
  if (bytes > 1_048_576) return { ...brief, recording: { status: "unavailable", reason: "bounded" } };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Metadata directory is not private");
    // A per-file byte limit alone still permits unbounded disk growth. Stop
    // retaining new artifacts at saturation; never delete the user's evidence.
    // This synchronous check serializes this process, not unrelated writers.
    if (readdirSync(directory).length >= 256) {
      return { ...brief, recording: { status: "unavailable", reason: "bounded" } };
    }
    const traceHash = createHash("sha256").update(diagnostic.traceId).digest("hex").slice(0, 12);
    const file = `metadata-${traceHash}-${diagnostic.physicalSend}-${randomUUID()}.json`;
    writeFileSync(join(directory, file), encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { ...brief, recording: { status: "written", file, bytes, sha256: createHash("sha256").update(encoded).digest("hex") } };
  } catch {
    return { ...brief, recording: { status: "unavailable", reason: "io_failed" } };
  }
}
