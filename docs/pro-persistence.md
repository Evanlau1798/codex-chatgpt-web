# Owned Pro-turn persistence

A five-minute supervision interval is an update cadence, not a provider deadline. Keep the same owned request, client/session and waiter while work remains observable; never duplicate an uncertain Send.

Browser turns have no overall deadline unless explicitly configured. SSE heartbeats preserve transport but do not manufacture content or prove provider progress. Actual partial provider output is forwarded when available.

Native MCP work inherits only an explicit owner deadline. Without one, wait until result, cancellation, revocation or connection failure rather than applying an arbitrary 90-second limit. Active owned tool calls suppress DOM-health missing-response verdicts; stale settled progress and implausible future clocks do not. Inference compaction likewise has no implicit five-minute deadline, and preserves the physical source ownership boundary. Generic bounded transaction defaults and explicitly configured deadlines remain honored.

Browser errors remain authoritative when broker retirement races with their outcome wrapper. Forward the actual retirement cause to remote owners instead of replacing it with a generic revoked-token error.

Opt-in real MCP stdio/socket tests use `CGW_LONG_TOOL_ACCEPTANCE=1` (95 seconds) and `CGW_LONG_COMPACTION_ACCEPTANCE=1` (310 seconds). These are transport tests, not model-generation tests. Provider/security/quota/network and external tunnel lifetime limits remain. No infinite-availability guarantee is made.
