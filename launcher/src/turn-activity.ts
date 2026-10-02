import type { BrowserTabState } from "./types";

// Three missed ten-second observations hide the old waiting state. This changes
// only its presentation; it does not cancel a turn or declare a provider failure.
const STALE_AFTER_MS = 30_000;

export function describeTurnActivity(tab: BrowserTabState, now: number) {
  if (tab.status !== "running" || tab.interactionMode === "manual") return null;
  if (tab.authenticationRequired) return { state: "sign-in" as const, elapsedMs: null, ageMs: null };
  const activity = tab.activity;
  if (!activity || now < activity.updatedAt) {
    return { state: "unknown" as const, elapsedMs: null, ageMs: null };
  }
  const ageMs = now - activity.updatedAt;
  if (ageMs > STALE_AFTER_MS) return { state: "stale" as const, elapsedMs: null, ageMs };
  return { state: activity.state, elapsedMs: Math.max(0, now - activity.since), ageMs };
}
