import {
  chatGptTurnSessions,
  type ChatGptTurnSessions,
} from "../adapters/chatgpt-web/turn-execution";
import { readClaudeQueuedSteering } from "./claude-transcript-steering";
import { claudeSessionThreadId } from "./request";

const MAX_HOOK_BYTES = 2 * 1024 * 1024;

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
  if (typeof body.session_id !== "string" || !body.session_id.trim()) {
    return new Response("Invalid Claude hook", { status: 400 });
  }
  const threadId = claudeSessionThreadId(body.session_id);
  if (body.hook_event_name === "PostToolUse" || body.hook_event_name === "PostToolUseFailure") {
    if (typeof body.transcript_path !== "string" || !body.transcript_path.trim()) {
      return new Response("Invalid Claude tool hook", { status: 400 });
    }
    try {
      const results = readClaudeQueuedSteering(body.transcript_path, body.session_id)
        .map(queued => sessions.steerClaudeRoot(threadId, queued.prompt, queued));
      const accepted = results.filter(result => result === "accepted").length;
      if (accepted > 0) {
        console.info(`[chatgpt-web] accepted ${accepted} queued Claude steering prompt(s) for the active root Web conversation`);
      } else if (results.includes("ambiguous")) {
        console.warn("[chatgpt-web] ignored queued Claude steering because multiple active root turns matched the session");
      } else {
        console.debug("[chatgpt-web] found no new queued Claude steering for the active root Web conversation");
      }
    } catch (error) {
      console.warn(`[chatgpt-web] could not inspect the Claude transcript for queued steering: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new Response(null, { status: 204 });
  }
  if (body.hook_event_name !== "UserPromptSubmit"
    || typeof body.prompt !== "string" || !body.prompt.trim()) {
    return new Response("Invalid UserPromptSubmit hook", { status: 400 });
  }
  const result = sessions.steerClaudeRoot(threadId, body.prompt);
  if (result === "accepted") {
    console.info("[chatgpt-web] accepted Claude UserPromptSubmit steering for the active root Web conversation");
  } else if (result === "ambiguous") {
    console.warn("[chatgpt-web] ignored Claude UserPromptSubmit steering because multiple active root turns matched the session");
  } else {
    console.debug("[chatgpt-web] ignored Claude UserPromptSubmit hook without an active root Web conversation");
  }
  return new Response(null, { status: 204 });
}
