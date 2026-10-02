# Measured native-backend loop

Readiness, transport liveness, returned tool evidence, final delivery and task acceptance are different facts.

## Readiness

`codex-chatgpt-web doctor --native --json` performs an explicit, read-only inspection of the idle automatic launcher's Native app settings and tool catalog. It does not send a model request or change permissions. The client lab additionally checks health/config/source versions, matches built and configured runtime CLI hashes, and refuses write acceptance when permission/catalog evidence is missing, stale or incomplete. A selected “Allow all tools” policy does not waive provider safety checks or native-client safeguards.

The inspection waits for a real catalog row, not just the asynchronously rendered dialog heading. It refuses navigation over a visible unsent draft and restores the previous URL. Busy active turns are not interrupted. Local admin/control endpoints require their existing private control credentials; no new public service is created. UI labels currently support the observed English interface; unknown values fail closed.

## Results and finalization

Native tool receipts retain the real call ID, wire name, returned/error state and output hash. Execution status/exit code remain unknown unless a command result supplies a typed exit field. Tool prose is not reclassified into an exit code or a policy failure. The original output and failure flag remain unchanged. Optional MCP metadata is additive; ordinary internal broker results retain their original shape.

Structured workflow diagnostics distinguish acknowledged/held output, queued output, completion-fence commitment and client delivery (not yet observed). Benchmark acceptance requires the terminal native-client final, exact disk edit, unchanged tests and an independent runner exit. An acknowledgement alone never establishes task success. Actual observed provider/owned-tool states are distinct from transport heartbeats; diagnostics do not create partial answers or new timeout/retry behavior.

The captured failing Claude baseline is replayed through the real translation and MCP stdio/socket paths. Assertions retain exact content, call binding and is_error=true. The word “rejected” in a passing validation-test name does not justify attributing the command to a security policy. Existing recorded DONE/late-abort fixtures and ownership/conflict guards remain.

## Efficiency and reproducible comparison

Successful read evidence should be reused until freshness or verification requires another read. No read is automatically cached, suppressed or replaced; mutations and requested fresh reads remain legitimate. Prompt instructions stay within the measured archive-bootstrap budget.

From `tools/native-client-lab`, a matched, signed-in bridge can run:

```sh
node bin/benchmark.mjs --rounds 2 --unsafe --provider-log /absolute/private/bridge.log
```

`--unsafe` is explicit and only appropriate for user-authorized disposable acceptance; it does not alter global permissions. Each paired round uses identical initial source/tests/prompt; order alternates Codex→Claude then Claude→Codex. Cases and captures remain private in a new temporary directory. There is no whole-query timeout or automatic retry, and the benchmark stops on its first failed oracle. Do not rerun an uncertain in-flight request.

Reports measure elapsed time, actual native tool/read/repeat-read counts, captured response bytes, client HTTP round trips, owned provider Sends/recovery Sends and independent verification. Provider receipts are correlated through the bound cwd hash, never the client banner. Repeat reads are reported, not automatically declared unnecessary. Billing cost is unmeasured; bridge token estimates are not provider billing evidence. Small paired samples are diagnostic, not statistically conclusive rankings or guarantees of maximum efficiency.
