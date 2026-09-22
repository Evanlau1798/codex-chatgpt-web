import { expect, test } from "bun:test";
import { PiRpcRun } from "../scripts/lifecycle-smoke/pi-rpc";
import { closePiRpcRuns } from "../scripts/lifecycle-smoke/pi-lane";

test("Pi RPC reader retains only bounded event evidence and exact inert markers", async () => {
  const script = `
    const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
    emit({type:"message_start",message:{role:"user",content:"private prompt text"}});
    emit({type:"tool_execution_start",toolCallId:"call-1",toolName:"bash",args:{command:"node --version"}});
    emit({type:"tool_execution_end",toolCallId:"call-1",toolName:"bash",isError:false,
      result:{content:[{type:"text",text:"v22.19.0 private command output"}]}});
    emit({type:"message_end",message:{role:"assistant",stopReason:"stop",
      content:[{type:"text",text:"PI_STEER_LIVE_OK private response"}]}});
    emit({type:"agent_settled"});
    setTimeout(() => {}, 10000);
  `;
  const run = new PiRpcRun([process.execPath, "--eval", script], import.meta.dir,
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  try {
    await run.waitFor(value => value.type === "agent_settled", 5_000);
    expect(run.events.some(value => value.type === "message_start")).toBe(true);
    expect(run.events.find(value => value.type === "tool_execution_start")?.commandMatched).toBe(true);
    expect(run.events.find(value => value.type === "tool_execution_end")?.versionObserved).toBe(true);
    expect(run.events.find(value => value.type === "message_end")?.message?.content?.[0]?.text).toBe("steered");
    expect(JSON.stringify(run.events)).not.toContain("private");
  } finally { await run.close(); }
});

test("Pi RPC cleanup rejects a natural nonzero exit after the required event", async () => {
  const script = 'console.log(JSON.stringify({type:"agent_settled"}));setTimeout(()=>process.exit(7),20)';
  const run = new PiRpcRun([process.execPath, "--eval", script], import.meta.dir,
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  await run.waitFor(value => value.type === "agent_settled", 5_000);
  await expect(closePiRpcRuns([run])).rejects.toThrow("Pi RPC cleanup failed");
});
