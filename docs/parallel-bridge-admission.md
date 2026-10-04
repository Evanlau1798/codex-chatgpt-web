# Bounded native-agent admission (opt-in)

`experimentalParallelSubagents: true` enables admission derived from native
thread/session ancestry, never user or tool prose. It admits one task tree,
one coordinator and two workers, with a separate one-document compaction
reserve. The existing physical browser ceiling still applies; configured
maxBrowserTabs must be at least four. Manual mode does not enable this feature.
Disabled mode preserves existing routing fingerprints and behavior.

An unrelated queued root cannot sit ahead of active children or compaction and
deadlock the parent. A third/nested worker is refused before provider Send,
with a non-retryable capacity error, rather than queued behind the parents that
it would need to finish. Start with flat delegation and native-client worker
limits matching two children. This is admission control, not an agent manager
or permission override. Each agent retains its own native tool gates and
workspace; assign independent files or native-supported worktrees for edits.

Queued cancellation removes only that waiter. Active Pro work has no new
lifetime timer and is not preempted for queue fairness. Ancestor lookup fails
closed on cycles/ambiguous ownership. Admission identity is forwarded through
the launcher helper; both coordinator and helper enforce the same bound. This
is a single managed bridge/helper design, not a cross-process distributed quota.

Transport/operation tests and scheduler tests do not prove parallel inference.
Live acceptance must show two distinct owned generation intervals overlap,
each model receipt resolves correctly, tools/results stay with their call ids,
independent file hashes and test exits match, and the parent integrates results.
Benchmark identical task partitions at sequential and two-worker settings;
report verified completion time and failures, not request counts as productivity.

The lab `parallel-benchmark.mjs` runs either client with `--mode parallel` or
`--mode sequential`, immutable test fixtures, exact edit hashes and a separate
test runner. `--parallel-agents` enables Codex v2 only for that invocation;
ordinary lab tests continue disabling delegation. Pinned Codex v2 ignores
`agents.max_depth`, so native graph/task-path ancestry is checked by this bridge
before Send; the compatibility flag is not the enforcement boundary. Claude's
client metadata identifies workers but not their nesting depth, so its measured
bound is two simultaneous worker turns, not proven nested-spawn prevention.
The opt-in lab pins `agents.default_subagent_model` to its one-row Pro catalogue
for that invocation only. An inherited canonical-home worker default must not
silently select an unavailable or differently routed model. Ordinary invocations
and global Codex configuration remain unchanged.
Receipt/visible-generation
correlation requires the diagnostics and receipt packets (#74/#76) in the
deployed composition. Overlap means distinct owned visible generation intervals
with wire model receipts, not GPU scheduling or proven provider throughput.
Sequential acceptance also requires two closed observed worker intervals:
missing observations must not masquerade as zero overlap. Both benchmark modes
report client-completion wall time separately from independent verification.
Output directories must be empty; only explicit interrupts or exceptional
harness failure tear down the owned child, never slow provider generation.
Keep all experimental packets draft until that real-client acceptance passes.
