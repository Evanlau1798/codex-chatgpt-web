# Native long-command handoff candidate

Recorded tunnel traffic from the failed 330-second Claude command contains
`command response deadline reached; dropping without posting a response`,
followed by tools/call and initialize 502 errors. Official tunnel-client source
at c8aeedec334db55bbd69bb16db6b71276993d708 derives this response deadline from
the control-plane command's response_timeout. A connection TTL does not remove
that per-command deadline. This is not evidence that slow Pro inference should
be cancelled, nor that MCP progress notifications extend the deadline.

When the current Claude catalog advertises Bash.run_in_background and
TaskOutput.timeout, this candidate projects Bash calls with an explicit timeout
above 30000ms into native background tasks. The command and its original timeout
remain unchanged. Only TaskOutput's response-wait timeout is capped to 30000ms;
the task remains alive. Instructions require retrieving the same native task id,
not repeating the command or treating a pending handle as successful completion.
Other clients/tools, short commands, freeform requests and unsupported catalogs
are not rewritten. This is not a generic asynchronous adapter for all tools.

Verification: focused normalization and routing tests, exact command/lifetime
preservation, catalog gating, and root typecheck. Live acceptance is outstanding:
the current installed v6.1.4 app returns HTTP404 for guarded native readiness and
desktop-control startup failed. No provider request was sent around that gate.

Required live oracle: one native command increments a disposable counter once,
runs longer than five minutes, returns its real output and exit status through
the same task id, and delivers a native client final with an owned Pro wire
receipt. Repeat the identical experiment after any failure; do not resubmit
solely because model reasoning or the command is still running.
