# Composer reliability: implementation and verification

## Scope and status

First-phase implementation covers **A (diagnostics/contracts), B (cancellation/deadline ownership), C1 (terminal integrity classification/replay), and E (bounded same-owned-page observation recovery)**. These are code deliveries, not a declaration that the reported incidents are fixed on every platform.

**C2 is BLOCKED on actual incident evidence.** The supplied pack contains synthetic text/DOM shapes, not the failing ChatGPT Lexical state or the original #43 prompt. No LF, NBSP, writer, or extractor correction is inferred from that pack. The lack of this evidence does not block A/B/C1/E.

**Phase-one scope did not include second-phase work.** The candidate writer/budget and general-client API are now delivered separately in orders 08–11 below; neither changes the default writer or promotes a release. No plugin host, #40 account/profile pool, token/proxy rotation, account guard weakening, or API route was added. No automatic merge or release is part of this work.

## Submission order

| Order | Branch | Boundary |
|---|---|---|
| 01 | `codex/01-composer-insertion-baseline` | Existing strategy planner and 12 reproducible synthetic fixtures |
| 02 | `codex/02-composer-cancel-boundaries` | Stop orchestration after cancellation |
| 03 | `codex/03-composer-diagnostics` | Text contract, content-free mismatch/phase diagnostics, actual edit counters |
| 04 | `codex/04-composer-operation-deadlines` | Remaining-budget propagation, independent cleanup, uncertain-mutation isolation |
| 05 | `codex/05-prompt-integrity-terminal-replay` | Integrity error, canonical-revision terminal receipt, helper/HTTP/SSE/compact mapping |
| 06 | `codex/06-bounded-same-page-recovery` | One shared recovery episode, typed viewport evidence, target and late-connect ownership |
| 07 | `codex/07-phase-one-verification` | Offline browser probe, real Activity/export privacy check, this handoff |

Review/merge in that order; each PR is based on the preceding branch. After merging a predecessor, verify the next PR's base before merging. There are no document-version labels in the submission titles.

## Delivered behavior

### A — Strategy, text contract, and observable work

The caller's existing opt-ins and the strict `> 32000` condition still select `guarded-chunked`, `direct-text`, or `direct-html`. CR/NUL inputs remain in the text path. The splitter still respects its whitespace and surrogate boundaries. No successful path gained an extra verification pass or a writer fallback.

The existing comparison contract is explicit: remove the known UI pills/cursor targets; keep the current top-level child text/LF representation and `trimStart`; compare UTF-16 units, allowing only the existing one-way ASCII-space-run to NBSP representation. Internal LF, a literal NBSP, U+200B/U+2060, and Unicode sequences are not silently folded. Characterization tests deliberately document the existing nested-BR/inline-sibling representation rather than changing it to fit expected text.

Insertion logs identify trace/stage, the actual strategy/shape, insert/verify/boundary-restore/Markdown-restore/reanchor/final-verify phases, inserted/verified prefix units, elapsed time, actual chunks, remaining markers, native edit attempts/acceptances, and restoration batches. Marker progress is throttled, not logged once per marker. A final summary is emitted on success/failure after the insertion owner settles.

Native counters are returned from the renderer around the actual `execCommand` calls. One 128-marker restoration evaluate is not reported as one native edit. `nativeEditCountsComplete=false` means unresolved/failed transport evidence cannot prove the complete count; the returned counts are only confirmed counts. A fully verified **guarded prefix** is not a verified final payload while Markdown restoration remains unfinished.

Mismatch diagnostics expose only lengths, prefix/suffix lengths, delta, and a conservative whole-difference classification. A `+1` length alone is not called a single LF insertion. Public errors do not include codepoint windows, prompt slices, hashes of prompt content, DOM, account paths, or raw capture. The bounded local-only codepoint helper inspects at most six points without allocating the entire suffix. A production logger/export test checks the new diagnostic payload end to end.

### B — One current stage budget, then cleanup or isolation

`ChatGptPromptOperation` receives the current stage's remaining awake-time budget. Nested acquisition/read/focus/edit/caret/restoration operations can shorten but not replenish that budget. Existing stage timeout values, suspension refunds, and turn-timeout policy are unchanged.

Read-only waits may detach on cancellation/deadline; late values cannot authorize the next operation. Native edits are awaited rather than declared settled when an abort promise wins. Each follow-up operation rechecks the same cancellation/deadline. A transport timeout/cancel that cannot prove the renderer stopped becomes an uncertain persistent-browser-state error.

Cleanup has its own existing bounded allowance, independent of the already-cancelled turn signal. If an edit or cleanup does not physically settle, the error explicitly requires surface retirement/isolation. The launcher retains only successfully completed surfaces; a failed or uncertain surface is not handed back as a healthy composer. An in-flight synchronous renderer batch is not claimed to be physically interrupted by a JavaScript AbortSignal.

### C1 — Completed comparison failures are not transient readiness failures

A completed mismatching readback now produces `chatgpt_prompt_integrity_mismatch`, HTTP 502/server_error, `retryable: false`, with physical session retirement. A missing/unresponsive reader instead remains a readiness/attachment timeout. Cleanup failure following a known mismatch preserves the terminal integrity classification and the retirement requirement.

The existing retry-policy owner holds a small process-local terminal receipt because physically retiring the existing session otherwise removed the only protection against a native reconnect starting the same failed insertion again. Its key includes native owner/execution identity, request revision, normalized context/tool results, and options. It is **not a global text-only blacklist**. Transport streaming flags and message timestamps do not mint a new attempt. New human revisions, new native turns, and changed tool results remain distinguishable.

Receipts use an absolute 30-minute TTL and a maximum 256 entries; replay does not extend the TTL. Restart, expiry, and capacity eviction are explicit limits, not durable exactly-once guarantees. The existing transient-retry clear does not erase a terminal receipt.

Tests cross the real helper-frame error reconstruction, worker retry owners, production parser/adapter, ordinary JSON/SSE Responses, and compact HTTP error mapping. Six same-request attempts enter the injected production writer orchestration only once; new revisions/turns remain eligible. The fixture does not execute real model inference. Compact errors now preserve an explicit boolean `retryable` field instead of dropping it.

### E — Reobserve the same owned work; never resend it

Observation and rebind-readiness failures consume **the same maximum two rebinds** and one 60-second recovery-episode budget, additionally capped by the remaining configured turn deadline. The recovery timer is not refreshed by MCP heartbeats or by starting another rebind. A first transient rebind-readiness failure can use the second attempt; a second failed observation cannot then create two more attempts.

The viewport reader distinguishes an actually responsive but undersized viewport from a renderer that never answers. A closed target, unknown transport failure, ownership mismatch, or cancellation is not automatically recategorized as a transient viewport retry. There is at most one outstanding renderer read in the viewport check. Launcher renderer lifecycle events remain the place to distinguish a reported crash from other unresponsive-renderer causes; a timeout alone is not a crash diagnosis.

The authenticated heartbeat/viewport refresh and existing exact launcher surface selection remain. Reacquisition must also preserve the original registered CDP target ID. Newly acquired transports are owned before viewport checking; failed provisional connections are closed by the next acquisition or terminal cleanup. A connect returning after cancellation is closed without observing or adopting that page.

Both the normal and tunneled response loops use this recovery owner; submission/new-assistant waits use the same bounded primitive. Existing broker binding/call IDs, completion evidence, and turn identity checks are preserved. No recovery operation contains Send, a new chat, a new broker turn, or command replay. The real broker test completes a delivered inert call during recovery and rejects duplicate completion/requeue.

## Verification ledger

All statements here distinguish synthetic/offline results from account-bound validation. Use the PR's CI checks for the exact published head; a historical green run is not a replacement.

| Layer / gate | Evidence | State |
|---|---|---|
| G0 baseline | Locked Bun 1.4.0; original PR 02 baseline: root suite, 251 isolated test files | PASS locally |
| G0 candidate | Full root suite, 255 isolated test files, plus the newly added Activity/export test; focused recheck after final counter-admission adjustment | PASS locally |
| A / G1 | Planner/threshold/splitter/contract/privacy/native-edit-vs-batch tests; all 12 supplied synthetic cases reconstructed, not raw transcripts | PASS locally |
| B / G2 | Remaining-budget/suspension, pre/post-await cancellation, real operation settlement, independent cleanup expiry, transport ambiguity | PASS locally; installed-app gate below remains NOT_RUN |
| C1 / G3a | Helper frame + worker owners + production adapter/JSON/SSE/compact; six same-request attempts, new revision/turn, TTL/capacity, authoritative preparation errors | PASS locally |
| C2 / G3b | Actual #43 LF root cause and failing Lexical DOM/prompt | BLOCKED; synthetic fixtures are not incident proof |
| E / G5 | First rebind failure then second success, shared budget, target mismatch, cancellation, late connection, real broker delivery/completion | PASS locally; installed native integration gate below remains NOT_RUN |
| Launcher | Typecheck, 506 tests, renderer build | PASS locally |
| Offline Chromium | 12 supplied cases + exact threshold cases + large CR/NUL direct-text + root remount + cancellation during a native edit; injected LF/reorder/NBSP differences rejected | PASS locally in standalone Chromium, not Lexical |
| Optional large lane | 350K plain guarded text completes; 330K dense Markdown exhausts the unchanged 90-second budget during restoration | KNOWN FAIL; explicit second-phase performance limitation, not hidden/skipped |
| Pinned native CLI lifecycle | Run `bun run lifecycle:sim --lane=all`; requires a normal-user writable isolated runtime | See exact PR CI run / execution record; not a logged-in ChatGPT result |
| Windows installed app / ChatGPT / Codex | Real account-bound regression, including current installed launcher/helper and Native2 | NOT_RUN — user-side validation required |
| Linux/macOS incident reproduction | Original reporter's platform/package/input | NOT_RUN |

A Linux standalone probe observed the optional dense 330K case select 21 chunks and 37,984 Markdown delimiters. The last complete evidence was in `markdown_restore`, with 28,329 confirmed native edits and 9,696 markers still remaining; the complete edit count was unknown. These are **one synthetic local run's measurements**, not a claim to have reproduced #42 or a cross-platform benchmark. No timeout or writer was changed to make it green.

## Reproducible commands

From the repository root with the pinned dependencies installed:

```sh
bun install --frozen-lockfile
bun install --cwd launcher --frozen-lockfile
bun run typecheck
bun run test
bun run launcher:typecheck
bun run launcher:test
bun run launcher:build
bun run lifecycle:sim --lane=all
```

Use `bun run verify` in an environment that can perform the dependency audits and runtime packaging checks. Do not bypass audit failures or claim an offline subset is the full verification command.

One explicit browser entry point runs only new, empty, isolated contexts and blocks all remote requests. It does not load a saved browser profile, launch the app's login flow, attach to an existing ChatGPT tab, or submit a prompt:

```sh
bun run scripts/check-composer-reliability.ts --chromium=/path/to/installed/chromium
# Optional characterization lane; currently expected to expose the dense-restoration limit.
bun run scripts/check-composer-reliability.ts --chromium=/path/to/installed/chromium --large
```

Windows PowerShell example:

```powershell
bun run scripts/check-composer-reliability.ts '--chromium=C:\Program Files\Google\Chrome\Application\chrome.exe'
```

The probe writes `tmp/composer-reliability/fixture-result.json` and `.md`, including commit, tracked-worktree state, runtime/browser versions, strategy, counts, and outcomes. Nonzero failures produce a nonzero exit code. No expected/observed payload, DOM dump, account details, or screenshot is exported. Keep the optional large result separate from the ordinary pass result when archiving evidence.

## User-side installed Windows checklist

- [ ] Record exact application/helper commit/build, Windows version, installed Codex version, harness/model, Enhanced/Bigger/No Context settings. Finish active work before switching builds; do not overwrite a live profile or manually clear pending tool ownership.
- [ ] Run the offline commands above. Record the result files and CI head, not just an overall "tests passed" sentence. The standalone browser probe is L2 evidence only.
- [ ] In normal, user-initiated app operation, confirm the new strategy/stage/phase diagnostics are present in Activity and the safe export, including a large inline request and a multipart request. Never share raw prompts, browser profiles, or original private DOM.
- [ ] Cancel during attachment/restoration and observe bounded failure/cleanup. Start a new user turn only after the old surface settles or is retired. Confirm no leftover edits or automatic Send. An unresponsive renderer must be retired rather than reused.
- [ ] For a reproducible integrity failure, confirm the same native request returns the same terminal error without another browser insertion; a genuinely new user revision is not suppressed. This is C1 validation, not proof the LF root cause is fixed.
- [ ] For a genuinely triggered #44-style observation failure, confirm the same surface/target, native turn and delivered call IDs survive a successful second rebind; Send activation stays at one. If recovery fails or ownership is lost, completion must remain unconfirmed. A routine successful turn does not validate this failure path.
- [ ] Leave C2 and reporter-platform reproduction unconfirmed until their own evidence exists. Do not close #42–#44, switch the default writer, raise the global budget, or mark release-ready solely because A/B/C1/E offline checks pass.

Rollback the stacked changes in reverse submission order. There is no persistent settings/schema migration in this series. Reverting C1 restores the older retry behavior, so do not repeatedly replay an unchanged known integrity-failing request as a workaround.


## Second-phase candidate delivery — orders 08–11

The selected second-phase implementation is delivered as two independent opt-ins:
`experimentalComposerPlainText` for the large guarded writer, and a listener-scoped
`CODEX_CHATGPT_WEB_API_KEY` for the general-client Chat Completions API. Both are
absent/off by default. No merge, release, default promotion, account manager,
credential pool, plugin runtime or upstream context-partitioning change is included.

| Order | Branch | Scope |
|---|---|---|
| 08 | `codex/08-composer-candidate` | Large guarded text uses existing one-shot native text edit; one shared plan, hard/stall budget and compaction repair deadline |
| 09 | `codex/09-chat-completions-contract` | Strict text/function Chat Completions parsing, role/history pairing, schema/output validation and visible token cap |
| 10 | `codex/10-chat-completions-local-api` | Scoped loopback admission, JSON/SSE routes, existing worker/queue/safety reuse, cancellation and bounded buffering |
| 11 | `codex/11-phase-two-verification` | Real unmodified pi offline probe, supported configuration, measured evidence and Windows handoff |

Review and merge in order after 07. Confirm each next PR's base when a predecessor
is merged. Candidate/API setup and rollback are in [composer-candidate.md](composer-candidate.md)
and [chat-completions.md](chat-completions.md). They may be enabled independently.

### Measured scope, not speculative replacement

The writer candidate changes **only >32000-unit inputs that previously selected
`guarded-chunked`**, such as large multipart stages. It keeps already-direct inline
HTML/text paths unchanged. An exploratory same-size inline comparison found HTML
about 272ms versus plain text about 6.6 seconds; overriding that path was rejected.
All old readbacks and fresh pre-Send proof remain. There is no automatic alternate
writer retry or normalization that accepts added/removed LF.

Measurements below used an isolated clean worktree at
`de1d767a94511d549ddd28a9ae3e576690ad57d5`, Bun 1.4.0, Linux standalone Chromium
144.0.7559.96, synthetic-only contenteditable. A subsequent order-08 commit only
consolidates identical boolean validation to keep `config.ts` below its existing
500-line architectural gate; it does not change the measured writer or budget.
Repeated probes record three warm-up rounds separately from the thirty measured
rounds. Short/direct comparisons alternate baseline/candidate order. No other
heavy verification was running during these measurements.

| Case | Baseline | Candidate | Meaning |
|---|---|---|---|
| Full default + large fixture set | Earlier phase-one large lane retained a dense failure | 22 cases, 0 failures, 0 false acceptances | Offline shapes only; no live Lexical claim |
| Short `c01`, 30 measured per variant | p50 87ms; p95 97ms | p50 89ms; p95 111ms | +14ms p95, below the planned max(10%, 50ms) degradation bound |
| Existing direct boundary 32001, 30 per variant | p50 87ms; p95 98ms | p50 88ms; p95 97ms | Direct path kept; no measured threshold regression |
| Guarded 330K dense Markdown | Failed at 90,110ms in `markdown_restore` | 30/30 succeeded; p50 6513.5ms, p95 6900ms | Candidate avoids restoration with one native edit; no percentage speedup computed against a failed baseline |

The remeasured guarded failure had 21 chunks and 37,984 delimiters. Its last
returned evidence was 29,225 confirmed native edits, 229 restoration batches,
8,800 remaining markers and `nativeEditCountsComplete=false`. A verified guarded
prefix of 330,000 units is not a verified final payload. The baseline failure and
its nonzero exit remain in the local evidence instead of being hidden by the
candidate passing. Earlier phase-one measurements above are separate runs.

The candidate keeps finite 60/90-second hard ceilings and a 20-second no-verified-
progress bound, shortened by parent awake-time remaining budget. Verified prefix
or marker progress counts; polling, edits alone and unrelated heartbeat do not.
The existing safe compaction repair consumes the same original deadline. Physical
mutation settlement/cleanup still precedes reuse or uncertain-surface retirement.

### General-client authority and pi evidence

`/v1/models` and `/v1/chat/completions` are the only routes available to the general
key. The key cannot access native, admin, launcher, compact or health routes.
Requests use standard JSON or Chat Completions SSE, never renamed Responses events.
Function arguments are validated without repair/coercion; tools execute in pi and
return by exact call ID. Unsupported semantic fields and malformed output fail
explicitly. Streaming tool JSON is withheld until the completed bound output is
validated. Visible-output `max_tokens` uses `o200k_base`; provider usage and hidden
reasoning budgets are not invented. Stream queues have a 4 MiB byte cap.

The API reuses the actual browser worker, shared admission slots, account guard and
cancellation/cleanup. It creates no native environment, broker capability, MCP
connector or retained session pool. Each POST supplies full client-owned history
for a fresh Temporary Chat. Distinct HTTP attempts are not falsely deduplicated by
prompt text. The documented pi configuration disables automatic retries.

The explicit `scripts/check-chat-completions-pi.ts` uses real unmodified pi 0.86.1
(package `@earendil-works/pi-coding-agent`) and Node 22.20.0. Production HTTP,
compiler, runtime and validators are exercised against a scripted model worker;
pi performs only a read and a write inside a disposable inert directory. It also
checks an SDK-visible SSE error and an RPC abort that settles the original runtime.
This is **real-client/offline-model** evidence, not Windows or ChatGPT inference.
The safe report records exact commit, runtime, client and tracked-worktree state.

### Validation ledger and remaining gates

| Gate | Recorded result / limitation |
|---|---|
| W focused | 16 candidate tests, including actual worker call/plan/budget propagation and no compaction deadline refill; passed |
| W architectural regression | Initial full root run exposed `config.ts` at 502 lines (limit 500); identical feature checks consolidated, unchanged gate then passed |
| API focused | 59 tests / 181 assertions across production contract/runtime/HTTP passed after numeric and bounded-SSE fixes |
| Full TypeScript | Passed against real installed frozen dependencies |
| Launcher | 506 tests, typecheck and renderer build passed |
| Codex/Claude offline lifecycle | `ALL_DETERMINISTIC_LIFECYCLE_LANES_OK`; final 270-test lane passed, no actual ChatGPT inference |
| Full root suite / final heads | Consult each PR's exact-head CI and final verification comment; the initial line-limit failure is not relabeled a pass |
| G4 offline candidate | The measured synthetic cases above pass; original guarded failure retained separately |
| G-API-0/1/2 offline | Standard pi configuration, protocol/tool pairing, route/authority isolation, safety, limits and cancellation covered |
| G-API-PI Windows live | NOT_RUN: maintainer's installed candidate, unmodified pi and actual ChatGPT model/tool rounds required |
| G3b / C2 original LF root cause | BLOCKED: original failed Lexical state and incident prompt still unavailable |
| G4 Windows / G6 promotion | NOT_RUN: installed launcher/helper, real composer and multipart/native ownership checks required; no release authorized |

Before promotion, drain active work and verify the installed Windows candidate
with a minimal, inert test directory and the existing account-safety rules. Confirm
both actual model/tool rounds, exact arguments/results, fresh chats, no native
capability for the API key, cancellation settlement, candidate multipart ACK order
and unchanged existing Codex/Claude use. A rate-limit/security signal stops testing;
there is no account switching, extra profile copy or automatic retry to obtain green.
A normal successful request is not proof of the original #43/#44 failure path.

Offline code delivery does not mark Windows/live, original incident reproduction,
or release promotion complete. Disabling the two opt-ins and restarting only after
drain restores the existing entry points/writer; no persistent data migration is
required. Preserve integrity and no-resend protections during any rollback.
