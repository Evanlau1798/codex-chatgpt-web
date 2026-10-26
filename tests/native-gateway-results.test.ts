import { expect, test } from "bun:test";
import { decodeGatewayResult } from "../src/adapters/chatgpt-web/gateway-result";

const marker = "codex-tool-result:fixture:";
const record = (value: unknown) => ({ type: "text", text: marker + JSON.stringify(value) });

test("gateway result restores public metadata while preserving literal text and multimodal content", () => {
  const image = { type: "image", data: "encoded", mimeType: "image/png" };
  const result = decodeGatewayResult({ content: [image,
    { type: "text", text: "before\r\n" + marker + '{"structuredContent":{"pending":true},"isError":true}\r\nafter\n' },
  ] }, marker);
  expect(result).toEqual({ content: [image, { type: "text", text: "before\r\nafter\n" }],
    structuredContent: { pending: true }, isError: true });
});

test("inner success cannot overwrite an outer execution failure", () => {
  const failed = { content: [{ type: "text", text: "Script failed" }], isError: true };
  expect(decodeGatewayResult(failed, marker)).toBe(failed);
  const truncated = { content: [{ type: "text", text: marker + "broken" }], isError: true };
  expect(decodeGatewayResult(truncated, marker)).toBe(truncated);
  expect(decodeGatewayResult({ content: [record({ isError: false })], isError: true }, marker).isError).toBeTrue();
});

test("gateway metadata requires exactly one invocation-bound valid record", () => {
  for (const content of [[], [record({}), record({})], [{ type: "text", text: marker + "broken" }],
    [record({ isError: "true" })], [record({ structuredContent: [] })], [record({ structuredContent: null })],
    [record({ _meta: { token: "hidden" } })], [{ type: "text", text: "codex-tool-result:other:{}" }],
  ]) expect(() => decodeGatewayResult({ content }, marker)).toThrow("Native gateway");
});

test("gateway keeps native executor truncation warnings when the metadata tail survives", () => {
  // Codex rust-v0.155.1 code_mode/mod.rs + utils/output-truncation/src/lib.rs framing.
  const received = "Script completed\nWall time 0.1 seconds\nOutput:\n"
    + "Warning: truncated output (original token count: 1000)\nTotal output lines: 3\n\n"
    + "head…990 tokens truncated…tail\n";
  const result = decodeGatewayResult({ content: [{ type: "text", text: received + marker
    + '{"structuredContent":{"status":"ready"},"isError":false}' }] }, marker);
  expect(result.content).toEqual([{ type: "text", text: received }]);
  expect(result.structuredContent).toEqual({ status: "ready" });
  expect(result.isError).toBeFalse();
});
