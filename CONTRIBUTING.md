# Contributing

Codex Web GPT was created and is primarily developed and maintained by
[@miuuyy](https://github.com/miuuyy). Product direction, core architecture, and release decisions
remain with the creator. Other contributors listed by GitHub have provided focused external fixes
rather than shared product or architectural ownership.

External contributions are welcome, but this is an intentionally maintainer-led project. Pull
requests are expected to be small, focused, and easy to review and verify. Good contributions
include isolated bug fixes, regression tests, documentation corrections, and narrow
platform-specific fixes.

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

Launcher changes must preserve native packaging on macOS, Windows, and Linux. Platform packages
must be built on their matching operating system. See [DEV chat mode](docs/dev-chat.md) for isolated
browser and MCP development, and [release validation](docs/release-validation.md) for the required
account-bound release checks.

## Live lifecycle smoke gate

`bun run verify` and focused regression tests are the deterministic baseline. They do not replace
the live lifecycle smoke when a change can alter production session ownership or cross-process
behavior. Run the live gate before merge for changes to:

- agent spawn, messaging, interrupt, close, parent/child tracking, or lifecycle callback wiring;
- tool-result delivery, steering, cancellation, compaction, resume, or retained sessions;
- launcher-owned daemon/browser ownership, Codex or Claude protocol bridges, or the lifecycle
  smoke runner itself.

Documentation-only changes and isolated utilities that cannot affect those boundaries do not need
the live gate. Run it only after deterministic verification passes and the launcher-owned daemon is
healthy, accepting turns, and idle. The command uses the signed-in ChatGPT account, creates real Web
sessions, consumes account usage, and writes bounded redacted artifacts under
`tmp/lifecycle-smoke/runs/`; never commit those artifacts. Keep every model-facing lifecycle smoke
prompt and its validation vocabulary in English so contributors reproduce the same standardized
flow regardless of their local language.

```sh
bun run scripts/lifecycle-smoke/run.ts --live --lane=codex
bun run scripts/lifecycle-smoke/run.ts --live --lane=claude
bun run scripts/lifecycle-smoke/run.ts --live --lane=all
```

Use the Codex or Claude lane for client-specific changes and `all` for shared lifecycle changes.
Record the resulting `LIFECYCLE_SMOKE_PASSED` path in the pull request. A contributor who cannot run
the authenticated gate should say so explicitly; a maintainer must run the required lane before
merge or release.
