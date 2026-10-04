import { expect, test } from "bun:test";
import { NativeReadinessInspectionError, nativeReadinessFailureReason } from "../src/adapters/chatgpt-web/native-readiness-client";

test("readiness failures expose only bounded cause enums, never helper error details", () => {
  const cases = [
    ["browserType.connectOverCDP: Timeout 19783ms exceeded. PRIVATE_TOKEN", "browser_control_attach_timeout"],
    ["native_readiness_generation_active: navigation refused PRIVATE_DRAFT", "generation_active"],
    ["native_readiness_unsent_draft: navigation refused PRIVATE_DRAFT", "unsent_draft"],
    ["unknown failure PRIVATE_TOKEN", "inspection_failed"],
    ["native_readiness_unsent_draft" + "x".repeat(4096), "inspection_failed"],
  ] as const;
  for (const [error, expected] of cases) {
    const reason = nativeReadinessFailureReason({ error });
    expect(reason).toBe(expected);
    expect(new NativeReadinessInspectionError(reason).message).not.toContain("PRIVATE");
  }
  expect(nativeReadinessFailureReason({ error: {} })).toBe("inspection_failed");
  expect(nativeReadinessFailureReason(null)).toBe("inspection_failed");
});
