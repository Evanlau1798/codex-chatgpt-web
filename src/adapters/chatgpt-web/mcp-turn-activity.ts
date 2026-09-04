import { randomBytes } from "node:crypto";
import type { ChatGptTurnEnvironment } from "./environment";
import type { ChatGptMcpContract } from "./mcp-zero-risk";
import { callTurnBroker } from "./turn-broker";

export interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

async function settleTurnActivity(socketPath: string, token: string, activityId: string): Promise<void> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await callTurnBroker(socketPath, { method: "activity_complete", token, activityId }, 5_000);
      return;
    } catch (error) {
      firstError ??= error;
    }
  }
  throw new AggregateError([firstError], "Codex Native broker activity cleanup failed after an idempotent retry");
}

export async function withClaimedTurn<T>(
  socketPath: string,
  token: string,
  signal: AbortSignal | undefined,
  action: (claimed: ClaimedTurn) => Promise<T> | T,
  contract: ChatGptMcpContract = "native",
): Promise<T> {
  const activityId = `activity_${randomBytes(18).toString("base64url")}`;
  let claimed: Omit<ClaimedTurn, "activityId">;
  try {
    claimed = await callTurnBroker(
      socketPath,
      { method: "claim", token, activityId, contract },
      contract === "safe" ? null : 5_000,
      signal,
    );
  } catch (error) {
    try {
      await settleTurnActivity(socketPath, token, activityId);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex Native claim failed and its activity could not be retired");
    }
    throw error;
  }
  try {
    return await action({ ...claimed, activityId });
  } finally {
    await settleTurnActivity(socketPath, token, activityId);
  }
}
