# Resumable native operations (opt-in)

Add `--resumable-operations` to the Native MCP command to advertise
`codex_operation_start` and `codex_operation_result`. Existing tool calls and
stdio remain unchanged unless explicitly selected. These are operation handles,
not another agent scheduler. The client still executes tools with its original
permissions, sandbox and native tool semantics.

Use the exact advertised wire_name/arguments plus one stable operation_key per
intended slow invocation. A one-second initial response grace returns the real
native result when available, otherwise a pending operation_id. Reconnecting
and repeating the same key and payload retrieves that invocation; a different
payload with the same key is rejected. Response cancellation removes only the
reader. Explicit owner retirement/revocation invalidates operations. There is
no implicit native work-lifetime timer and no automatic replay after a crash.

Result retrieval accepts wait_ms up to 30000 on HTTP, and zero on shared stdio
to avoid head-of-line blocking. Pending is not success. native_invocation_complete
does not mean a child agent completed: Codex v2 wait_agent can wake for mailbox
activity or new input. Native errors remain errors in MCP results. Parent
finalization is fenced until its operation result is consumed.

There is one unconsumed operation per native turn and at most 64 retained keys.
Keys are not evicted within a turn, so capacity cannot turn an ambiguous retry
into a repeated side effect. Results are capped at 16 MiB each/32 MiB per turn;
Even a synchronous dispatch exception retains its key as an unknown-outcome
tombstone. It cannot report invocation completion or make a retry replay work.
delivery-capacity failures are explicit errors and forbid command replay.
Operations are process-local: a broker restart invalidates handles rather than
claiming a running command is resumable. Durable native task recovery is a
separate concern; preserve external task ids/receipts and verify them first.

Local acceptance uses real SDK/HTTP/broker sockets, a real child process, an
independent file counter, result correlation, reconnect, ownership refusal and
error checks. It does not establish ChatGPT transport adoption or real-client
parallel inference. Those remain live acceptance requirements.
