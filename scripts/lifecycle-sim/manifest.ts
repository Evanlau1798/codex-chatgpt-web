export const codexLifecycleTests = [
  "tests/native-steering-boundary.test.ts",
  "tests/local-compaction-release.test.ts",
  "tests/subagent-environment-inheritance.test.ts",
] as const;

export const claudeLifecycleTests = [
  "tests/claude-compact-agents.test.ts",
  "tests/claude-steering-replay.test.ts",
  "tests/claude-session-abort.test.ts",
] as const;

export const sharedLifecycleTests = [
  "tests/server-adapter-injection.test.ts",
  "tests/server-compaction.test.ts",
  "tests/compaction-budget.test.ts",
  "tests/compact-replacement-budget.test.ts",
  "tests/retained-compaction-handoff.test.ts",
  "tests/turn-broker-lifecycle.test.ts",
  "tests/lifecycle-sim-evidence.test.ts",
  "tests/lifecycle-sim-codex-evidence.test.ts",
  "tests/lifecycle-sim-production-composition.test.ts",
  "tests/lifecycle-race-ordering.test.ts",
  "tests/zero-risk-http-composition.test.ts",
  "tests/zero-risk-compaction.test.ts",
  "tests/zero-risk-owner-retirement.test.ts",
] as const;
