# Opt-in Native MCP HTTP transport

`codex-chatgpt-web mcp --contract native --transport http --port 17842`
starts a loopback-only stateless Streamable HTTP endpoint at `/mcp`. The default
remains stdio. This command reads the existing private control token from the
selected bridge configuration; requests must use Bearer authorization. Never
put the token in a URL, public log or PR. This does not change global client
routes, tunnel profiles, plugin permissions, or credentials.

Each authenticated POST has its own MCP server/transport and RPC namespace, so
different callers may reuse JSON-RPC ids without cross-delivery or a shared
stdio lifecycle lock. Native broker claims and all native permissions remain
unchanged. Responses have a content-free request correlation id. Cross-origin,
rebinding Host, non-JSON and unauthenticated requests are refused before tool
dispatch. Bodies are capped at 32 MiB and active HTTP requests at 32. Graceful
shutdown waits for real requests rather than applying a work-lifetime timeout.

Use an explicitly configured existing tunnel profile only after live
compatibility is established; no automatic transport migration occurs. HTTP
does not remove control-plane response deadlines: slow operations still need
resumable native operation handles. Local real SDK/socket/broker tests prove
transport isolation, not ChatGPT acceptance or parallel inference.
