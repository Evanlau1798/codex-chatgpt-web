# Contributing

Codex Web GPT was created and is primarily developed and maintained by
[@miuuyy](https://github.com/miuuyy). Product direction, core architecture, and release decisions
remain with the creator. Other contributors listed by GitHub have provided focused external fixes
rather than shared product or architectural ownership.

External contributions are welcome, but this is an intentionally maintainer-led project. Pull
requests are expected to be small, focused, and easy to review and verify. Good contributions
include isolated bug fixes, regression tests, documentation corrections, and narrow
platform-specific fixes.

Before opening a bug report, work through [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and use the
structured issue form. Reproduce once on the latest release and attach the privacy-safe export from
**Activity → Export safe log**; never upload raw browser state, credentials, or unredacted logs.

Large feature branches, broad refactors, rewrites, new providers, and changes to core behavior or
architecture are generally not accepted. In rare cases they may be considered, but discuss the
proposal in an issue before implementation. Prior discussion does not guarantee acceptance, and a
large unsolicited pull request may be closed even when substantial work went into it.

## Scope and invariants

- Keep the project focused on ChatGPT web-backed Codex models. Generic providers and unrelated
  product surfaces are out of scope.
- Model selection is explicit. Never silently fall back to another model or reasoning level.
- Full mode exposes local tools only through the active outer Codex registry and official MCP
  tunnel. Browser-only mode must not create a broker capability or attach an MCP connector.
- Every available ChatGPT Web effort has the same turn-bound MCP capability in Full mode. Do not
  add effort-specific MCP exclusions.
- Preserve fail-closed behavior. A selector or protocol failure must return an explicit error, not
  pick another option or claim success.
- Never commit browser state, cookies, API keys, tunnel IDs, Codex history, generated logs, or
  absolute user paths.

## Before opening a pull request

1. Run `bun install --frozen-lockfile` in the repository root and in `launcher/`.
2. Run `bun run verify`.
3. Add a focused regression test for behavior changes.
4. For browser UI changes, include the observed DOM evidence and a reproducible fixture. Do not
   broaden selectors speculatively.
5. Keep Terms and trademark claims factual. Do not market the project as a quota or rate-limit
   bypass.
6. Manually test the affected behavior. DEV mode is sufficient only when the change does not affect
   local-tool execution, MCP execution, or the outer Codex agent loop. Execution changes require a
   real installed Codex integration; DEV simulation is not end-to-end acceptance evidence.

Launcher changes must preserve native packaging on macOS, Windows, and Linux. Platform packages
must be built on their matching operating system.

## Lifecycle verification gate

Focused tests and the deterministic lifecycle simulator are the baseline for changes that can alter
production session ownership or cross-process behavior, including:

- agent spawn, messaging, interrupt, close, parent/child tracking, or lifecycle callback wiring;
- tool-result delivery, steering, cancellation, compaction, resume, or retained sessions;
- launcher-owned daemon/browser ownership, Codex or Claude protocol bridges, or the lifecycle
  smoke runner itself.

Documentation-only changes and isolated utilities that cannot affect those boundaries do not need
this gate. Keep every model-facing prompt, sentinel, and validation term in English.

Choose the narrowest profile that covers the changed boundary:

| Profile | Required evidence |
| --- | --- |
| Focused tests | The smallest regression test for the changed behavior. |
| `codex` | Compatibility V1 and native V2 clients, cancellation, and Codex-owned lifecycle behavior. |
| `claude` | Claude Messages tool, subagent, interruption, compaction, and resume behavior. |
| `all` | Both clients, the exact evidence oracle, production-composed adapter/session/TurnBroker wiring, deterministic race orderings, and shared cleanup. |
| Web contract | One short account-bound turn plus allowlisted browser capabilities; `browserIdle` means only that no browser turn remains. |
| `deep` | A manual `deep` diagnostic for account-bound investigation, never a default gate. |

```sh
bun run lifecycle:sim --lane=all
```

Run one low-usage Web contract smoke only when browser UI, launcher ownership, or Web transport
changed. It verifies the signed-in surface and one short turn; it is not a multi-turn lifecycle
suite. Its `browserIdle` result does not prove full daemon idle. Full daemon idle requires no active
HTTP or browser turn, no live session registry entry, and no active broker capability. Any 429 or
verification limit stops the run immediately without retry. The old full live lifecycle flow is a
manual `deep` diagnostic profile, never a default CI or release gate. Redacted artifacts belong
under `tmp/lifecycle-smoke/runs/` and must never be committed.

Before a release-bound push, tag, or publication, run `bun run verify:release` locally. This hard
gate runs the full offline verification, starts the freshly built candidate runtime on an isolated
loopback port, then sends one short account-bound Web request through it. CI intentionally runs only
`bun run verify` because hosted runners have no login state. An earlier run against another runtime
is not release evidence. Run the request-heavy `deep` profile only when the changed lifecycle scope
or a specific investigation requires it, and keep the no-retry rule for 429 or verification limits.
