import { expect, spyOn, test } from "bun:test";
import {
  reportNativePassthroughDiagnostic,
  type NativePassthroughDiagnostic,
} from "../src/native-passthrough";

function diagnostic(
  overrides: Partial<NativePassthroughDiagnostic> = {},
): NativePassthroughDiagnostic {
  return {
    outcome: "completed",
    endpoint: "responses",
    requestBytes: 2_000_000,
    forwardedBytes: 2_000_000,
    contentEncoding: "zstd",
    bodyRewritten: false,
    inputItems: 100,
    imageItems: 2,
    imageUrlChars: 12_000_000,
    summaryTruncated: false,
    visitedNodes: 5_000,
    prepareMs: 1,
    headersMs: 2_000,
    upstreamStatus: 200,
    requestId: null,
    errorPhase: null,
    errorName: null,
    errorCode: null,
    ...overrides,
  };
}

test("does not warn for a successful large native request containing images", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    reportNativePassthroughDiagnostic(diagnostic());
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("continues to warn for native upstream errors and severe latency", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    reportNativePassthroughDiagnostic(diagnostic({ upstreamStatus: 400 }));
    reportNativePassthroughDiagnostic(diagnostic({ headersMs: 5_000 }));
    reportNativePassthroughDiagnostic(diagnostic({ outcome: "failed", errorPhase: "headers" }));
    expect(warn).toHaveBeenCalledTimes(3);
  } finally {
    warn.mockRestore();
  }
});
