import type { Rpc } from "./codex-app-server";
import { assert } from "./common";

export type V2Activity = {
  id: string;
  kind: "started" | "interacted" | "interrupted";
  parentThreadId: string;
  agentThreadId: string;
  agentPath: string;
  at: string;
};

function completedItems(messages: Rpc[], since: number): Rpc[] {
  return messages.filter(message => message.method === "item/completed"
    && Date.parse(message.receivedAt ?? "") >= since);
}

function legacyActivities(messages: Rpc[], since: number): V2Activity[] {
  return completedItems(messages, since).flatMap(message => {
    const item = message.params?.item;
    if (item?.type !== "subAgentActivity") return [];
    return [{
      id: String(item.id),
      kind: item.kind,
      parentThreadId: String(message.params?.threadId ?? ""),
      agentThreadId: String(item.agentThreadId ?? ""),
      agentPath: String(item.agentPath ?? ""),
      at: String(message.receivedAt ?? ""),
    } satisfies V2Activity];
  });
}

function collabActivityKind(tool: unknown): V2Activity["kind"] | undefined {
  switch (String(tool ?? "").toLowerCase()) {
    case "spawnagent": return "started";
    case "sendinput": return "interacted";
    case "interruptagent":
    case "closeagent": return "interrupted";
    default: return undefined;
  }
}

function collabActivities(messages: Rpc[], since: number): V2Activity[] {
  return completedItems(messages, since).flatMap(message => {
    const item = message.params?.item;
    if (item?.type !== "collabAgentToolCall" || item.status !== "completed") return [];
    const kind = collabActivityKind(item.tool);
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (!kind || receivers.length === 0) return [];
    return receivers.map((agentThreadId: string, index: number) => ({
      id: receivers.length === 1 ? String(item.id) : `${String(item.id)}:${index}`,
      kind,
      parentThreadId: String(item.senderThreadId ?? message.params?.threadId ?? ""),
      agentThreadId,
      agentPath: agentThreadId,
      at: String(message.receivedAt ?? ""),
    } satisfies V2Activity));
  });
}

export function normalizeV2Activities(messages: Rpc[], since: number): V2Activity[] {
  const legacy = legacyActivities(messages, since);
  return legacy.length > 0 ? legacy : collabActivities(messages, since);
}

export function selfTestV2ActivityNormalization(): void {
  const receivedAt = "2026-01-01T00:00:01.000Z";
  const event = (id: string, tool: string, sender: string, receiver: string): Rpc => ({
    method: "item/completed",
    receivedAt,
    params: {
      threadId: sender,
      item: {
        type: "collabAgentToolCall",
        id,
        tool,
        status: "completed",
        senderThreadId: sender,
        receiverThreadIds: [receiver],
      },
    },
  });
  const current = normalizeV2Activities([
    event("spawn", "spawnAgent", "root", "child"),
    event("message", "sendInput", "root", "child"),
    event("close", "closeAgent", "root", "child"),
  ], 0);
  assert(current.map(value => value.kind).join(",") === "started,interacted,interrupted",
    "Current collabAgentToolCall lifecycle normalization failed");
  assert(current.every(value => value.parentThreadId === "root" && value.agentThreadId === "child"),
    "Current collabAgentToolCall identities were not preserved");

  const legacy = normalizeV2Activities([event("spawn", "spawnAgent", "root", "child"), {
    method: "item/completed",
    receivedAt,
    params: {
      threadId: "root",
      item: {
        type: "subAgentActivity",
        id: "legacy",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/child",
      },
    },
  }], 0);
  assert(legacy.length === 1 && legacy[0]?.id === "legacy",
    "Legacy subAgentActivity events should remain authoritative when advertised");
}
