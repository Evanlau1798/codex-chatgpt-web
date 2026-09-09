import {
  parseChatGptLunaCheckpoint,
  type ChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

export type LauncherHelperMessage =
  | { type: "event"; id: string; event: "multipart_stage_acknowledged"; stageIndex: number }
  | { type: "ready"; features?: string[] }
  | { type: "event"; id: string; event: "heartbeat" | "send_activated" | "submitted" | "retry_submitted" | "reasoning" | "commentary" | "text"; text?: string; continuation?: boolean }
  | { type: "event"; id: string; event: "tool_batch_observed"; revision: number }
  | { type: "event"; id: string; event: "completion_fence_begin"; requestId: number }
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
  | { type: "event"; id: string; event: "answer"; text: string; attempt: number }
  | {
      type: "event";
      id: string;
      event: "error_retry";
      text: string;
      attempt: number;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
      retireSession?: boolean;
    }
  | { type: "event"; id: string; event: "luna_checkpoint"; checkpoint: ChatGptLunaCheckpoint; answerHash: string }
  | { type: "result"; id: string; text: string }
  | {
      type: "error";
      id: string;
      name?: string;
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
      retireSession?: boolean;
    };

export function parseLauncherHelperMessage(line: string): LauncherHelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type === "ready") {
    if (message.features !== undefined
      && (!Array.isArray(message.features) || message.features.some(feature => typeof feature !== "string"))) {
      throw new Error("Launcher browser helper advertised invalid features");
    }
    return {
      type: "ready",
      ...(message.features !== undefined ? { features: message.features as string[] } : {}),
    };
  }
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") return parseEvent(message as Record<string, unknown> & { id: string });
  if (message.type === "result") {
    if (typeof message.text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text: message.text };
  }
  if (message.type === "error") return parseError(message as Record<string, unknown> & { id: string });
  throw new Error("Launcher browser helper emitted an unknown message type");
}

function parseEvent(message: Record<string, unknown> & { id: string }): LauncherHelperMessage {
  const event = message.event;
  if (event === "multipart_stage_acknowledged") {
    if (!Number.isSafeInteger(message.stageIndex) || Number(message.stageIndex) <= 0) {
      throw new Error("Launcher browser helper multipart stage index is invalid");
    }
    return { type: "event", id: message.id, event, stageIndex: Number(message.stageIndex) };
  }
  if (event === "tool_batch_observed") {
    if (!Number.isSafeInteger(message.revision) || Number(message.revision) <= 0) {
      throw new Error("Launcher browser helper tool-boundary revision is invalid");
    }
    return { type: "event", id: message.id, event, revision: Number(message.revision) };
  }
  if (event === "completion_fence_begin") {
    if (!Number.isSafeInteger(message.requestId) || Number(message.requestId) <= 0) {
      throw new Error("Launcher browser helper completion fence request id is invalid");
    }
    return { type: "event", id: message.id, event, requestId: Number(message.requestId) };
  }
  if (event === "completion_fence_commit") {
    if (!Number.isSafeInteger(message.requestId) || Number(message.requestId) <= 0
      || !Number.isSafeInteger(message.revision) || Number(message.revision) < 0) {
      throw new Error("Launcher browser helper completion fence revision is invalid");
    }
    return {
      type: "event", id: message.id, event,
      requestId: Number(message.requestId), revision: Number(message.revision),
    };
  }
  if (event === "answer" || event === "error_retry") {
    if (typeof message.text !== "string" || !Number.isSafeInteger(message.attempt) || Number(message.attempt) < 1) {
      throw new Error("Launcher browser helper answer event is invalid");
    }
    if (event === "answer") {
      return { type: "event", id: message.id, event, text: message.text, attempt: Number(message.attempt) };
    }
    const structured = message.status !== undefined
      || message.errorType !== undefined
      || message.code !== undefined
      || message.retryable !== undefined;
    if (structured && (
      !Number.isInteger(message.status)
      || (message.status as number) < 400
      || (message.status as number) > 599
      || typeof message.errorType !== "string"
      || !message.errorType
      || typeof message.code !== "string"
      || !message.code
      || typeof message.retryable !== "boolean"
      || (message.retireSession !== undefined && typeof message.retireSession !== "boolean")
    )) throw new Error("Launcher browser helper error-retry event is invalid");
    return {
      type: "event", id: message.id, event, text: message.text, attempt: Number(message.attempt),
      ...(structured ? {
        status: message.status as number,
        errorType: message.errorType as string,
        code: message.code as string,
        retryable: message.retryable as boolean,
        ...(message.retireSession === true ? { retireSession: true } : {}),
      } : {}),
    };
  }
  if (event === "luna_checkpoint") {
    if (typeof message.answerHash !== "string" || !/^[a-f0-9]{64}$/.test(message.answerHash)) {
      throw new Error("Launcher browser helper Luna checkpoint answer hash is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event,
      checkpoint: parseChatGptLunaCheckpoint(message.checkpoint),
      answerHash: message.answerHash,
    };
  }
  if (event === "prepared_selected") {
    if (typeof message.reused !== "boolean") {
      throw new Error("Launcher browser helper prepared-selection event is invalid");
    }
    return { type: "event", id: message.id, event, reused: message.reused };
  }
  if (!["heartbeat", "send_activated", "submitted", "retry_submitted", "reasoning", "commentary", "text"].includes(String(event))) {
    throw new Error("Launcher browser helper emitted an unknown event");
  }
  if (message.text !== undefined && typeof message.text !== "string") {
    throw new Error("Launcher browser helper event text is invalid");
  }
  if (message.continuation !== undefined && typeof message.continuation !== "boolean") {
    throw new Error("Launcher browser helper continuation flag is invalid");
  }
  return {
    type: "event",
    id: message.id,
    event: event as "heartbeat" | "send_activated" | "submitted" | "retry_submitted" | "reasoning" | "commentary" | "text",
    ...(message.text !== undefined ? { text: message.text as string } : {}),
    ...(message.continuation !== undefined ? { continuation: message.continuation as boolean } : {}),
  };
}

function parseError(message: Record<string, unknown> & { id: string }): LauncherHelperMessage {
  const structured = message.status !== undefined
    || message.errorType !== undefined
    || message.code !== undefined
    || message.retryable !== undefined;
  if (typeof message.message !== "string"
    || (message.name !== undefined && typeof message.name !== "string")
    || (structured && (
      !Number.isInteger(message.status)
      || (message.status as number) < 400
      || (message.status as number) > 599
      || typeof message.errorType !== "string"
      || !message.errorType
      || typeof message.code !== "string"
      || !message.code
      || typeof message.retryable !== "boolean"
      || (message.retireSession !== undefined && typeof message.retireSession !== "boolean")
    ))) {
    throw new Error("Launcher browser helper error payload is invalid");
  }
  return {
    type: "error",
    id: message.id,
    message: message.message,
    ...(message.name !== undefined ? { name: message.name as string } : {}),
    ...(structured ? {
      status: message.status as number,
      errorType: message.errorType as string,
      code: message.code as string,
      retryable: message.retryable as boolean,
      ...(message.retireSession === true ? { retireSession: true } : {}),
    } : {}),
  };
}
