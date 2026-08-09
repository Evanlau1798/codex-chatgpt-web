import {
  chatGptTurnSessions,
  chatGptTurnSteeringId,
  type ChatGptTurnSessions,
} from "../adapters/chatgpt-web/turn-execution";
import { claudeSessionThreadId } from "./request";

const MAX_HOOK_BYTES = 128 * 1024;

export async function handleClaudeSteeringHook(
  request: Request,
  sessions: ChatGptTurnSessions = chatGptTurnSessions,
): Promise<Response> {
  const encoded = new Uint8Array(await request.arrayBuffer());
  if (encoded.byteLength > MAX_HOOK_BYTES) return new Response("Hook body is too large", { status: 413 });
  let body: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    return new Response("Invalid hook body", { status: 400 });
  }
  if (body.hook_event_name !== "UserPromptSubmit"
    || typeof body.session_id !== "string"
    || typeof body.prompt !== "string"
    || !body.session_id.trim()
    || !body.prompt.trim()) {
    return new Response("Invalid UserPromptSubmit hook", { status: 400 });
  }
  const steeringId = chatGptTurnSteeringId(claudeSessionThreadId(body.session_id), "claude_root");
  if (sessions.steer(steeringId, body.prompt)) {
    console.info("[chatgpt-web] accepted Claude UserPromptSubmit steering for the active root Web conversation");
  }
  return new Response(null, { status: 204 });
}
