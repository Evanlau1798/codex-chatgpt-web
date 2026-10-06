import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeOperation, readNativeOperation } from "../src/adapters/chatgpt-web/turn-broker-operations";
import type { TurnChannel } from "../src/adapters/chatgpt-web/turn-broker-state";

test("a synchronous dispatch failure after a real effect cannot replay the operation key", async () => {
  const root = mkdtempSync(join(tmpdir(), "operation-ambiguous-"));
  const counter = join(root, "counter.txt");
  writeFileSync(counter, "0");
  const channel = { traceId: "ambiguous-dispatch", activities: new Set<string>(),
    completedActivities: new Set<string>(), activityRevision: 0, invocations: new Map() } as TurnChannel;
  const request = { wireName: "exec_command", freeform: false, arguments: { cmd: "owned-effect" } };
  const enqueue = () => {
    writeFileSync(counter, String(Number(readFileSync(counter, "utf8")) + 1));
    throw new Error("dispatch became ambiguous after the effect");
  };
  try {
    expect(() => startNativeOperation(channel, "same-key", request, enqueue)).toThrow();
    expect(() => startNativeOperation(channel, "same-key", request, enqueue)).toThrow();
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(channel.nativeOperations?.size).toBe(1);
    const retained = channel.nativeOperations!.get("same-key")!;
    await expect(readNativeOperation(channel, retained.id, 0, new AbortController().signal)).rejects.toThrow("unknown");
    expect(channel.activities.size).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
