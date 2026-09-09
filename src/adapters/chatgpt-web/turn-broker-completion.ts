import type { TurnChannel } from "./turn-broker-state";

const ACTIVITY_ID = /^activity_[A-Za-z0-9_-]{16,128}$/;

export function assertTurnActivityId(activityId: unknown): asserts activityId is string {
  if (typeof activityId !== "string" || !ACTIVITY_ID.test(activityId)) {
    throw new Error("turn activity id is invalid");
  }
}

export function claimTurnActivity(channel: TurnChannel, activityId: string): void {
  if (channel.completedActivities.has(activityId)) {
    throw new Error("turn activity was already completed before this claim settled");
  }
  if (!channel.activities.has(activityId)) {
    channel.activities.add(activityId);
    channel.activityRevision += 1;
  }
}

export function completeTurnActivity(channel: TurnChannel, activityId: string): boolean {
  if (channel.completedActivities.has(activityId)) return false;
  const completed = channel.activities.delete(activityId);
  channel.completedActivities.add(activityId);
  // A cleanup can overtake an ambiguously delivered claim. The tombstone prevents resurrection.
  channel.activityRevision += 1;
  return completed;
}

export function beginTurnCompletionFence(channel: TurnChannel): number | undefined {
  if (channel.completionCommitted) return channel.completionRevision;
  if (channel.activities.size > 0 || channel.invocations.size > 0) return undefined;
  return channel.activityRevision;
}

export function commitTurnCompletionFence(channel: TurnChannel, revision: number): boolean {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("turn completion fence revision is invalid");
  }
  if (channel.completionCommitted) return channel.completionRevision === revision;
  if (channel.activityRevision !== revision || channel.activities.size > 0 || channel.invocations.size > 0) {
    return false;
  }
  channel.completionCommitted = true;
  channel.completionRevision = revision;
  return true;
}
