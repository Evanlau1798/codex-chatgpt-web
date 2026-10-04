# CI observation, not inference deadlines

CI runs `verify --verbose` so root-worker file names, test outcomes and child
diagnostics appear while work is occurring. Verbose output is inherited rather
than retained until a potentially stuck child exits. Concise local verification
still buffers successful output and reports failed output, preserving its
existing behavior and exit-code oracle. A real child-process regression cannot
finish until an independent observer receives its output marker.

Superseded pull-request runs are cancelled within their own workflow/PR group;
main-branch runs are not preempted. This is not retroactive cancellation of older
runs that did not use a concurrency group. Full CI verification has a 30-minute
job budget instead of silently retaining a stuck test for the platform's much
longer default. No test is skipped and no pass/failure condition is relaxed.

These controls apply only to CI. They introduce no model-query, provider-stream,
native operation or live Pro lifetime deadline and do not resubmit inference.
When a suite stalls, use the last emitted file/boundary to make the next
experiment smaller. Treat download/auth, test-environment, protocol, and actual
model-behavior failures separately.
