import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { assertNativePluginReadiness } from "./native-readiness";

export type NativeReadinessFailureReason = "browser_control_attach_timeout" | "generation_active" | "unsent_draft" | "inspection_failed";
export function nativeReadinessFailureReason(value: unknown): NativeReadinessFailureReason {
  const message = value && typeof value === "object" && "error" in value ? value.error : undefined;
  if (typeof message !== "string" || message.length > 4096) return "inspection_failed";
  if (message.includes("native_readiness_generation_active")) return "generation_active";
  if (message.includes("native_readiness_unsent_draft")) return "unsent_draft";
  if (message.includes("browserType.connectOverCDP:") && /Timeout \d+ms exceeded/.test(message)) return "browser_control_attach_timeout";
  return "inspection_failed";
}

export class NativeReadinessInspectionError extends Error {
  constructor(readonly reason: NativeReadinessFailureReason) {
    super(`native_readiness_inspection_failed:${reason}`);
    this.name = "NativeReadinessInspectionError";
  }
}

export async function inspectLauncherNativeReadiness(descriptorPath: string) {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const response = await fetch(`${descriptor.control.endpoint}/v1/session/native-readiness`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { /* No raw helper text escapes. */ }
    throw new NativeReadinessInspectionError(nativeReadinessFailureReason(body));
  }
  const value: unknown = await response.json();
  assertNativePluginReadiness(value);
  return value;
}
