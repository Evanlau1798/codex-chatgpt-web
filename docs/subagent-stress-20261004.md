# Subagent edge stress: 2026-10-04

Source baseline: composed integration `157911fd`. Disposable live evidence is private at
`/private/tmp/subagent-stress-live.4BSqyL`; do not publish its raw captures or credentials.

## Independent oracles

Native client exit/final text is not acceptance. Each trial requires exact worker and
parent file bytes, an unchanged test hash, independently executed test exit zero,
owned provider-wire `gpt-6-pro` receipts, and two owned worker generation intervals.
Live launchers have no overall query timeout and diagnostic automatic retries are off.

## Results

| Boundary | Observation | Status |
| --- | --- | --- |
| Admission stress | 200 trees; two workers plus maintenance per tree; excess workers refused; cancellation and repeated/out-of-order releases leave capacity usable | Passed, deterministic in-process |
| Queue saturation | 64 queued roots, overflow refusal, cancellation frees capacity, 63 survivors plus replacement complete | Passed, deterministic in-process |
| Native lab | 56 socket/proxy/launcher tests passed; one optional installed-parser test skipped | Passed at stated test boundary, not provider acceptance |
| Operation/broker | Eight tests passed, including actual HTTP MCP reconnect, independent single file mutation, cancelled reader versus owner cancellation, delayed pipe reply and frame settlement | Passed local transport/native-process boundary |
| Browser control | Initially readiness succeeded, later helper attachment failed despite its debugging socket connecting; after graceful app restart readiness succeeded again | Live intermittent control failure; restart recovery observed, cause not fixed |
| Codex | First attempt refused at readiness before launching. After browser recovery, one owned Pro Send completed after 265,293 ms with 112 recorded transport heartbeats, no retry; native response reported connector JSON-RPC 32600 Session terminated, zero tool results/worker edits; independent test failed | Failed workflow; slow response persistence observed |
| Claude | After independently reconnecting the stopped managed tunnel: two background children started, 15 successful native tool results returned; parent issued TaskStop; all three browser bindings retired and response failed with binding revoked; no exact edits, independent test failed | Failed workflow; cancellation isolation defect reproduced |

The app restart also stopped its managed tunnel. Codex's connector error is
confounded by that maintenance side effect and is not evidence of a Codex model
capability defect. The configured tunnel was reconnected and verified ready before
the Claude trial. Claude's two child starts and tool results do not establish
completed Pro workers: no owned completed child model receipts were available.
Client-calculated token pricing is not provider billing evidence.

## Candidate fix from live failure

Claude children share the parent session/thread group, but have distinct agent turn
identities. `bindClaudeSessionAbort` previously retired the entire group on *any*
request abort. A regression failed with `[root, left, right]` cancelled when only
`left` was stopped. Cancellation now selects that child's steering identity inside
the existing namespaced group. Root cancellation still retires the group. Missing
child identity never falls back to broader cancellation.

The regression and missing-identity cases pass; existing root-abort and Messages
API tests pass; TypeScript typecheck passes. This candidate has **not** been
deployed or live revalidated. Do not describe it as empirically fixed in production.

## Restoration and remaining coverage

Experimental parallel admission was enabled only for these trials and then removed.
The normal service was restarted after independently confirming zero active turns.
Browser credentials, global native-client routes, plugin permissions, and tunnel
profile were not changed. The original config backup and captures remain private.

Still required: live child-only cancellation after deploying the candidate; complete
Codex and Claude parallel success; real worker overlap; nested Claude delegation
limits (the native metadata currently identifies child status, not nesting depth);
slow child generation beyond ordinary supervision intervals; conflicting writes,
compaction with active workers, restart/unknown-outcome recovery, and repeated
sequential-versus-parallel performance trials. No maximum-efficiency claim is made.
