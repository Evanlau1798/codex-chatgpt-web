# Composer reliability implementation

## 01 — Insertion strategy and synthetic baseline

The production writer now selects its existing `guarded-chunked`, `direct-text` or
`direct-html` route through one pure insertion plan. The plan records only text
shape: UTF-16 units, line count, longest text run, potential Markdown guard
replacements, and CR/NUL presence. The Markdown guard shares its delimiter
alphabet with the planner. These counts are not claims about actual native edit
or restoration batch counts. Runtime phase telemetry and workload-based timeout
policy are separate follow-ups; this change does not claim to complete them.

The existing 16,000-unit splitter is directly testable. Whitespace lookback and
surrogate-pair protection are retained; estimated `ceil(length / 16000)` is not
used as an actual chunk count. Direct insertion still requires the original
caller opt-in and strict greater-than-32,000 threshold. CR/NUL still exclude
HTML. Empty verification, both direct readbacks, reanchoring and the surrounding
worker's final verification are unchanged. No timeout or model defaults change.

### Fixture provenance

`tests/fixtures/composer-synthetic.ts` reconstructs the 12 cases supplied in
`composer-fixture-staging.zip` with the same seed, synthetic literals and parsed
text. The 89K and dense 330K cases are generated at test time. No raw conversation,
compiled private prompt, browser capture, token, private source path or source
mapping is included. The uploaded generator's I/O, private-method probing and
historical test-result claims are not imported into the test helper.

The source bundle explicitly calls these cases **synthetic-only**. They do not
reproduce issue #43. The original named boundary parameters are retained, but
are not confused with total string lengths; separate tests cover exact threshold
lengths. U+2028/U+2029 count as text-run boundaries in the planner. Markdown
delimiter counts are distinct from literal U+E000/U+F8FF occurrences.

### Verification

- Focused strict TypeScript check: passed for the source subset with local
  compile-only Playwright declarations. This is not the root typecheck against
  the installed dependency graph.
- 37 focused tests: passed under Node 22.16 after TypeScript compilation. Tests
  use basic `node:test` and `node:assert/strict`; no dependency or runner changes.
- Generated fixture parsed text: independently matched all 12 uploaded cases.
- Locator recordings exercise production orchestration and guard functions, not
  actual browser editing, readback semantics, or final Send.
- Full pinned Bun root suite, launcher suite and `bun run verify`: NOT_RUN in the
  implementation container (Bun and the repository dependency graph unavailable).
- Windows installed-package/ChatGPT/Codex verification: NOT_RUN; maintainer gate.
- Linux/macOS incident reproduction: NOT_RUN. No issue closure or release claim.

On the maintainer's existing Windows development checkout, run:

```powershell
bun test ./tests/prompt-insertion-plan.test.ts ./tests/prompt-fast-insertion.test.ts ./tests/prompt-direct-insertion.test.ts ./tests/prompt-caret.test.ts
bun run typecheck
bun run launcher:test
bun run verify
```

Inspect the existing scripts before any account-bound smoke test. Do not send
these large synthetic prompts automatically or run historical tool commands.

## Remaining boundaries

Cancellation/deadline completion, structured integrity failures with bounded
cross-layer retries, and same-owned-page recovery remain separately reviewable
work. A different default writer, performance budgets and a restricted Chat
Completions client API are later-stage changes, not part of 01. Multi-account
profiles, credential/token pools and account rotation remain out of scope.
