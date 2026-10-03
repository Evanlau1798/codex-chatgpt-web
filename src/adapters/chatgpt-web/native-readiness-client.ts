import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { assertNativePluginReadiness } from "./native-readiness";

export async function inspectLauncherNativeReadiness(descriptorPath: string) {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const response = await fetch(`${descriptor.control.endpoint}/v1/session/native-readiness`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`native_readiness_inspection_failed:${response.status}`);
  const value: unknown = await response.json();
  assertNativePluginReadiness(value);
  return value;
}
