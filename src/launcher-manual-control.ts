import { readLauncherBrowserHostDescriptor, LauncherBrowserTurnCancelledError, type LauncherBrowserHostDescriptor } from "./launcher-browser-host";

export class LauncherManualTurnTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnTimedOutError";
  }
}

export class LauncherManualTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnFailedError";
  }
}
export interface LauncherManualTurnOwner {
  traceId: string;
  helperPid: number;
}

export interface LauncherManualTurnStart extends LauncherManualTurnOwner {
  prompt: string;
  /** Used only when the exact retained ChatGPT conversation already owns the accumulated history. */
  resumePrompt?: string;
  conversationKey?: string;
}

export interface LauncherManualTurnLease {
  tabId: string;
  reused: boolean;
  deadlineAt: string | null;
  state: "awaiting-user" | "sent" | "running" | "completed";
}

export interface LauncherManualTurnEnd extends LauncherManualTurnOwner {
  status: "completed" | "failed" | "aborted";
  retain?: boolean;
}

export interface LauncherManualTurnTerminal {
  status: "cancelled" | "failed";
}

export const LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS = 10_000;
export const LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS = 40_000;
export const LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS = 15_000;

async function launcherManualRequest(
  descriptor: LauncherBrowserHostDescriptor,
  action: "start" | "wait-sent" | "wait-terminal" | "started" | "end" | "cancel",
  body: LauncherManualTurnStart | LauncherManualTurnOwner | LauncherManualTurnEnd,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/manual/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const decoded = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { response, body: decoded };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abort);
  }
}

function throwManualControlError(response: Response, body: Record<string, unknown>): never {
  const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  if (body.code === "turn_cancelled") throw new LauncherBrowserTurnCancelledError(message);
  if (body.code === "manual_turn_timed_out") throw new LauncherManualTurnTimedOutError(message);
  throw new LauncherManualTurnFailedError(message);
}

export async function startLauncherManualTurn(
  descriptorPath: string,
  activity: LauncherManualTurnStart,
  timeoutMs = LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS,
): Promise<LauncherManualTurnLease> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await launcherManualRequest(descriptor, "start", activity, timeoutMs);
  if (!response.ok) throwManualControlError(response, body);
  if (typeof body.tabId !== "string" || !body.tabId
    || typeof body.reused !== "boolean"
    || (body.deadlineAt !== null && (typeof body.deadlineAt !== "string" || Number.isNaN(Date.parse(body.deadlineAt))))
    || !["awaiting-user", "sent", "running", "completed"].includes(String(body.state))) {
    throw new LauncherManualTurnFailedError("Launcher returned an invalid manual turn lease");
  }
  return {
    tabId: body.tabId,
    reused: body.reused,
    deadlineAt: body.deadlineAt as string | null,
    state: body.state as LauncherManualTurnLease["state"],
  };
}

export async function waitForLauncherManualSent(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ sentAt: string | null }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const timeoutMs = options.timeoutMs ?? LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS;
  for (;;) {
    if (options.abortSignal?.aborted) throw new DOMException("Manual Sent wait aborted", "AbortError");
    const { response, body } = await launcherManualRequest(
      descriptor,
      "wait-sent",
      owner,
      timeoutMs,
      options.abortSignal,
    );
    if (response.status === 202 && body.status === "pending") continue;
    if (!response.ok) throwManualControlError(response, body);
    if (body.status !== "sent"
      || (body.sentAt !== null && (typeof body.sentAt !== "string" || Number.isNaN(Date.parse(body.sentAt))))) {
      throw new LauncherManualTurnFailedError("Launcher returned invalid manual Sent confirmation");
    }
    return { sentAt: body.sentAt as string | null };
  }
}

export async function markLauncherManualTurnStarted(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await launcherManualRequest(descriptor, "started", owner, timeoutMs);
  if (!response.ok) throwManualControlError(response, body);
}

export async function waitForLauncherManualTerminal(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LauncherManualTurnTerminal> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const timeoutMs = options.timeoutMs ?? LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS;
  for (;;) {
    if (options.abortSignal?.aborted) throw new DOMException("Manual terminal wait aborted", "AbortError");
    const { response, body } = await launcherManualRequest(
      descriptor,
      "wait-terminal",
      owner,
      timeoutMs,
      options.abortSignal,
    );
    if (response.status === 202 && body.status === "pending") continue;
    if (!response.ok) throwManualControlError(response, body);
    if (body.status !== "cancelled" && body.status !== "failed") {
      throw new LauncherManualTurnFailedError("Launcher returned an invalid manual terminal signal");
    }
    return { status: body.status };
  }
}

export async function endLauncherManualTurn(
  descriptorPath: string,
  activity: LauncherManualTurnEnd,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<{ cancelledByUser: boolean }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await launcherManualRequest(descriptor, "end", activity, timeoutMs);
  if (!response.ok) throwManualControlError(response, body);
  if (typeof body.cancelledByUser !== "boolean") {
    throw new LauncherManualTurnFailedError("Launcher returned an invalid manual turn release result");
  }
  return { cancelledByUser: body.cancelledByUser };
}

export async function cancelLauncherManualTurn(
  descriptorPath: string,
  owner: LauncherManualTurnOwner,
  timeoutMs = LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS,
): Promise<void> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const { response, body } = await launcherManualRequest(descriptor, "cancel", owner, timeoutMs);
  if (!response.ok) throwManualControlError(response, body);
}
