# Optional OpenCodex integration

This directory contains an optional, separately supervised OpenCodex integration for Codex Web GPT. It keeps the official Codex Web GPT runtime as the owner of the ChatGPT session and Codex connection, while routing non-ChatGPT-Web catalog rows through an isolated OpenCodex process.

The integration has four boundaries:

- `preload.ts` starts the official OpenCodex package in a separate process and installs the gateway only for exact `https://chatgpt.com/backend-api/codex/` requests.
- `dashboard.ts` exposes the OpenCodex dashboard on a private loopback port and proxies its HTTP/WebSocket routes without changing provider credentials.
- `launcher-surface.cjs` and `OpenCodexSurface.tsx` embed that dashboard in a sandboxed Electron `WebContentsView`. It has no launcher preload, Node access, ChatGPT storage partition or native Codex authority.
- `manager.cjs` validates package version/integrity, provider ownership and startup/catalog contracts. It stages a candidate before an idle-only restart and keeps versioned state outside the OpenCodex package directory.

The launcher patch is deliberately anchor-checked. When a future Codex Web GPT release changes the launcher structure, `prepareLauncher` stops before replacing the installed bundle. A verified release can then be adapted explicitly; an update never silently overwrites the integration or the provider configuration.

## Setup

Run the bootstrap script from this directory with the packaged Bun runtime and launcher paths supplied by the host:

```powershell
node .\bootstrap.cjs `
  --bun "C:\path\to\bun.exe" `
  --launcher "C:\path\to\Codex Web GPT.exe" `
  --core-home "C:\Users\you\.codex-chatgpt-web" `
  --codex-home "C:\Users\you\.codex"
```

The script creates only private integration state and a random local gateway key. It never edits OpenCodex sources. Install the official `@bitkyc08/opencodex` package into the configured version directory, then use `manager.cjs` to validate and stage the package and launcher candidate. The first application should be performed while Codex Web GPT has no active task.

After installation, the launcher sidebar exposes an **OpenCodex** surface. ChatGPT Web rows continue through the official route; OpenCodex rows use the isolated gateway. The OpenCodex dashboard remains available on the configured loopback dashboard port for recovery and administration.

## Update behavior

OpenCodex updates are versioned and verified separately from the launcher. The manager keeps the active package, candidate package, provider state and rollback snapshot in different paths. An active Codex turn prevents a restart; the validated candidate is staged and the update stays running while polling the atomic idle check for up to 30 minutes. It activates automatically when the check acquires maintenance. If the wait expires, retry after active tasks finish; the staged package is retained. A failed health, catalog or dashboard check leaves the previous package active.

The launcher integration is reapplied only when its source anchors and package identity match the installed official release. If they do not, the manager refuses the update and reports that an explicit adaptation is required. This protects both official launcher updates and the local integration from silent drift.

## Validation

The included tests cover exact-route transport isolation, loopback admission, dashboard forwarding, ownership rules, launcher-view isolation, renderer patch anchors and abandoned update-lock recovery. Tests use simulated HTTP and Electron surfaces; real provider credentials and account quotas are never required.

The integration intentionally does not alter OpenCodex upstream sources, Codex native configuration, ChatGPT Web effort detection or the Native2 connector contract.
