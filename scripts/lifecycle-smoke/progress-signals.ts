import type { LauncherEvent } from "./common";
import type { LifecycleProgressSignal, NativeToolActivity } from "./progress-watchdog";

interface RpcLike {
  method?: string;
  params?: any;
}

const SEMANTIC_ITEM_TYPES = new Set([
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "mcpToolCall",
  "subAgentActivity",
]);

const ACTIVE_ACTIVITY = /^\[chatgpt-web\] native-tool-activity trace=[A-Za-z0-9_-]{3,128} state=active kind=(web_search|native_tool) evidence=(streaming_busy|running_animation)$/;
const INACTIVE_ACTIVITY = /^\[chatgpt-web\] native-tool-activity trace=[A-Za-z0-9_-]{3,128} state=inactive reason=(dom_absent|generation_stopped|activity_changed|lease_ceiling)$/;

/** Convert noisy live-client records into the small signal set used by the bounded watchdog. */
export class CodexLifecycleProgressSignals {
  private readonly itemTransitions = new Set<string>();
  private readonly agentText = new Map<string, string>();

  fromRpc(message: RpcLike): LifecycleProgressSignal {
    if (message.method === "item/agentMessage/delta") {
      const itemId = String(message.params?.itemId ?? "");
      const delta = String(message.params?.delta ?? "");
      if (!itemId || !delta) return { kind: "liveness" };
      const current = this.agentText.get(itemId) ?? "";
      if (current.length > 0 && delta.startsWith(current)) return { kind: "liveness" };
      this.agentText.set(itemId, current + delta);
      return { kind: "semantic_progress" };
    }
    if (message.method !== "item/started" && message.method !== "item/completed") {
      return { kind: "liveness" };
    }
    const item = message.params?.item;
    const itemId = String(item?.id ?? "");
    const itemType = String(item?.type ?? "");
    if (!itemId || !SEMANTIC_ITEM_TYPES.has(itemType) || itemType === "reasoning") {
      return { kind: "liveness" };
    }
    const transition = `${message.method}:${itemType}:${itemId}`;
    if (this.itemTransitions.has(transition)) return { kind: "liveness" };
    this.itemTransitions.add(transition);
    return { kind: "semantic_progress" };
  }

  fromLauncher(event: LauncherEvent): LifecycleProgressSignal {
    if (event.event !== "runtime.daemon_stdout") return { kind: "liveness" };
    const line = String(event.detail?.line ?? "");
    const active = ACTIVE_ACTIVITY.exec(line);
    if (active) {
      return { kind: "native_tool_proof", activity: active[1] as NativeToolActivity };
    }
    if (INACTIVE_ACTIVITY.test(line)) return { kind: "native_tool_inactive" };
    return { kind: "liveness" };
  }
}
