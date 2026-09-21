# Candidate composer insertion

This option is **off by default**. It is a pre-release candidate, not a declaration
that the original Linux incidents or the signed-in ChatGPT Lexical editor are fixed.
It does not require or enable the general Chat Completions API.

After draining active work, add this optional boolean to the existing daemon
`config.json`, then restart the daemon/helper from the same candidate build:

```json
{"experimentalComposerPlainText": true}
```

Merge that property into the existing configuration; do not replace the whole
configuration with the example. Do not copy cookies, browser profiles, account
credentials or tokens. To roll back, drain work, remove the property or set it
false, then restart. Never switch builds while a message or tool result is in flight.

## Narrow strategy change

Only text **larger than 32,000 UTF-16 units that would otherwise use the guarded
chunk writer** switches to the existing one-transaction `insertText` operation.
Both complete readbacks, caret verification and the outer fresh pre-Send check
remain. No partial text or mismatched newline is accepted. CR/NUL remain literal
text inputs, not HTML parsing inputs.

Existing opted-in direct inline/compaction routes keep their original choice:
`direct-html` when eligible, otherwise `direct-text`. This is intentional: an
exploratory dense 330K inline fixture took about 272ms with the existing HTML
path, versus a roughly 6.6-second median for plain text. Replacing that already
fast path would be a regression. Those standalone measurements are not live
ChatGPT or cross-platform performance guarantees.

The shared insertion plan feeds the writer, diagnostic counters and candidate
budget. No new fourth transport, fallback ladder, observer cache, editor private
API, context partitioning, account switching or weaker comparator was added.

## Finite progress and cleanup

The candidate retains a hard ceiling of 60 seconds for guarded work and 90
seconds for direct work, always shortened by the parent stage/turn allowance.
No Context Window does not remove that ceiling. The existing safe compaction
repair shares its original candidate deadline; another attempt cannot refill it.

During editing, at most 20 seconds without verified progress is allowed. A growing
verified prefix, fewer verified remaining markers, and the first completed caret/
final-verification phase count as progress. Polling, repeated phase entry, native
edit attempts alone, unrelated MCP activity and heartbeat messages do not. Setup
before insertion is still covered by the hard stage budget. The clock retains
existing suspension accounting.

A timeout never means an edit physically stopped. Existing mutation settlement,
independent bounded cleanup and uncertain-surface retirement remain authoritative.
There is no automatic new chat or resend after Send activation.

## Offline verification

Use an already installed Chromium/Chrome executable. The probe uses fresh empty
contexts, blocks network, never loads a saved profile, and never presses Send:

```sh
bun test tests/prompt-candidate.test.ts
bun run scripts/check-composer-reliability.ts --chromium=/path/to/chrome --candidate --large
bun run scripts/check-composer-reliability.ts --chromium=/path/to/chrome --compare --case=c01 --repeat=30
bun run scripts/check-composer-reliability.ts --chromium=/path/to/chrome --candidate --large --case=multipart-330k-dense --repeat=30
```

`--compare` interleaves baseline/candidate order and records three warm-up rounds
separately before the requested measured rounds. Repeated single-variant runs also
record three warm-up rounds before the requested measured rounds. Do not run a 30-repeat baseline
of the already-known 90-second dense guarded failure merely to obtain a timing
ratio; report its failure separately. Output includes actual strategy, native edit
counts, remaining markers, failures and false acceptances. Logs/JSON stay under
`tmp/composer-reliability/` and must not be committed.

Standalone contenteditable success is only an offline gate. Before enabling the
candidate in a normal release, the maintainer must validate the installed Windows
launcher/helper with signed-in ChatGPT, real input shapes, cancellation, multipart
ACK ordering and Codex tool ownership. The original #43 failing Lexical fixture
remains unavailable; this option does not infer or claim its LF root-cause fix.
