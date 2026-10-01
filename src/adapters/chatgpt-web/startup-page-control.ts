import { readLauncherBrowserHostDescriptor, LAUNCHER_TURN_END_TIMEOUT_MS } from "../../launcher-browser-host";

/** Drain/shutdown/safety closes speculative pages only, never a retained or running task. */
export async function discardLauncherStartupPages(descriptorPath: string): Promise<number> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const response = await fetch(`${descriptor.control.endpoint}/v1/startup/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(LAUNCHER_TURN_END_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || !Number.isSafeInteger(body.closed) || Number(body.closed) < 0) {
    throw new Error(`Launcher startup cleanup was not acknowledged (${response.status})`);
  }
  return Number(body.closed);
}
