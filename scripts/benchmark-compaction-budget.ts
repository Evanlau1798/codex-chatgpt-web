import { createHash } from "node:crypto";
import { buildCompactV1Output } from "../src/responses/compaction";
import { estimateTokens } from "../src/lib/token-estimate";

// Opt-in CPU benchmark with functional oracles, no timing pass/fail threshold.
// No client, browser, credentials, external requests or files are used.
const input = Array.from({ length: 30_000 }, (_, i) => ({ type: "message", role: "user", id: `user-${i}`,
  content: [{ type: "input_text", text: "OK" }],
}));
const started = performance.now();
const output = buildCompactV1Output(input, "Current task checkpoint.");
const elapsed = performance.now() - started;
const bytes = JSON.stringify(output.slice(0, -1));
const tokens = estimateTokens(bytes);
if (tokens > 20_000 || output.at(-2)?.id !== "user-29999") throw new Error("Compaction stress outcome failed");
console.log(JSON.stringify({ messages: input.length, elapsed_ms: elapsed, retained_messages: output.length - 1,
  retained_tokens: tokens, latest_preserved: true, output_sha256: createHash("sha256").update(bytes).digest("hex"),
  timing_threshold: null, provider_inference: false }));
