import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnUserRevision, extractChatGptTurnUserText } from "./environment";
import type { TurnBroker } from "./turn-broker";
import type { ChatGptTurnRuntime, ChatGptTurnSession, ChatGptTurnSessions } from "./turn-execution";

export async function sessionForChatGptRequest(
  sessions: ChatGptTurnSessions,
  key: string,
  parsed: CodexParsedRequest,
  start: () => ChatGptTurnRuntime,
): Promise<ChatGptTurnSession> {
  const revision = JSON.stringify(extractChatGptTurnUserRevision(parsed));
  const text = extractChatGptTurnUserText(parsed) ?? "The user added a new instruction.";
  let session = sessions.getOrCreate(key, start);
  const steering = session.updateUserRevision(revision, text);
  if (!steering || session.runtime.mode === "tools") return session;

  await sessions.retireAndWait(key);
  session = sessions.getOrCreate(key, start);
  session.updateUserRevision(revision, text);
  return session;
}

export function deliverPendingChatGptSteering(
  session: ChatGptTurnSession,
  broker: TurnBroker,
  token: string,
  traceId: string,
): void {
  const steering = session.takePendingSteering();
  if (!steering) return;
  broker.requestSteering(token, `The user added this instruction while you were working:\n\n${steering}`);
  session.clearOutstanding();
  console.info(`[chatgpt-web] browser turn ${traceId} accepted native steering without opening a replacement tab`);
}
