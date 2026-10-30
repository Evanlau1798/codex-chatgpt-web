import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

for (const kind of ["goal", "delegation"] as const) {
  test(`restarted ${kind} provenance cannot promote an older retained human task`, () => {
    const project = resolve(import.meta.dir, "..");
    const scratch = mkdtempSync(resolve(project, "tmp", "task-proof-restart-"));
    assert(scratch.startsWith(resolve(project, "tmp") + sep));
    const path = resolve(scratch, "proof.json");
    const turn = `private_turn_${randomUUID()}`;
    const taskText = kind === "goal" ? "PRIVATE_GOAL: implement the current milestone"
      : "<codex_delegation><source_thread_id>coordinator</source_thread_id><input>PRIVATE_DELEGATION: implement the current milestone</input></codex_delegation>";
    const human = { type: "message", role: "user", id: "old-human", content: "PRIVATE_EARLIER_HUMAN: report status only",
      internal_chat_message_metadata_passthrough: { turn_id: "earlier" } };
    const task = kind === "goal"
      ? { type: "message", role: "user", id: "current-task", content: taskText,
          internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["goal.internal_context"] } }
      : { type: "function_call_output", id: "current-task", name: "send_message_to_thread", namespace: "codex_app", output: taskText,
          internal_chat_message_metadata_passthrough: { turn_id: turn } };
    const identity = { threadId: randomUUID(), turnId: turn };
    const body = { model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [human, task],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: identity.threadId, turn_id: turn }) } };
    const module = (name: string) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);
    const common = `
      import { parseRequest } from ${module("responses/parser")};
      import { encodeCompactionSummary } from ${module("responses/compaction")};
      import { loadCompactionContinuationState, rememberCompactionContinuation, restoreCompactionTaskMessages } from ${module("adapters/chatgpt-web/compaction-continuation")};
      import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity, chatGptTurnUserRevisionHistory } from ${module("adapters/chatgpt-web/environment")};
      import { compactRequest } from ${module("server")};
      import { defaultConfig } from ${module("config")};
      import { ChatGptBrowserWorker } from ${module("adapters/chatgpt-web/browser-worker")};
      import { compileChatGptWebPrompt } from ${module("adapters/chatgpt-web/prompt")};
      const body=${JSON.stringify(body)}, identity=${JSON.stringify(identity)}, human=${JSON.stringify(human)}, task=${JSON.stringify(task)}, taskText=${JSON.stringify(taskText)};
      const parsed = parseRequest(body); parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
      loadCompactionContinuationState(${JSON.stringify(path)});
      const summary = { type: "compaction", encrypted_content: encodeCompactionSummary("PRIVATE_SUMMARY: current implementation remains unfinished") };
    `;
    const probe = (code: string) => {
      const result = spawnSync(process.execPath, ["-e", common + code], {
        cwd: project, encoding: "utf8", windowsHide: true, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    };
    const replay = (input: string) => probe(`
      const replay = parseRequest({ ...body, input: ${input} }); replay._compactionRequest=true; replay._chatgptModelFamily="6";
      try {
        const source = extractChatGptCompactionSourceRevision(replay);
        const messages = restoreCompactionTaskMessages(replay, extractChatGptTurnIdentity(replay), chatGptTurnUserRevisionHistory(replay));
        console.log(JSON.stringify({ status:"accepted", source:source.content, taskCount:messages.filter(message=>message.content===taskText).length }));
      } catch (error) {
        console.log(JSON.stringify({ status:"rejected", code:error.code, httpStatus:error.status }));
      }
    `);
    try {
      expect(probe(`
        rememberCompactionContinuation(parsed, identity, [
          { itemId:task.id, turnId:identity.turnId, content:taskText },
          { itemId:human.id, turnId:"earlier", content:human.content },
        ], "PRIVATE_SUMMARY: current implementation remains unfinished");
        console.log(JSON.stringify({ saved:true }));
      `)).toEqual({ saved: true });
      const snapshot = readFileSync(path, "utf8");
      for (const secret of [taskText, human.content, "PRIVATE_SUMMARY", identity.threadId, turn]) expect(snapshot).not.toContain(secret);
      expect(replay("[human, task, summary]")).toEqual({ status: "accepted", source: taskText, taskCount: 1 });
      expect(probe(`
        const replay=parseRequest({...body,input:[human,task,summary,...Array.from({length:8},()=>({
          type:"message",role:"assistant",content:" observed detail".repeat(20000)
        }))]}); replay._compactionRequest=true; replay._chatgptModelFamily="6";
        replay.context.messages.push({role:"user",content:"FINAL_COMPACT_INSTRUCTION",timestamp:0});
        const compiled=compileChatGptWebPrompt(replay,{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true});
        const messages=JSON.parse(compiled.text.match(/<codex_context_json>\\n([^\\n]+)\\n<\\/codex_context_json>/)[1]).messages;
        console.log(JSON.stringify({trimmed:compiled.trimmedCompactionMessages>1,
          taskCount:messages.filter(message=>message.content===taskText).length}));
      `)).toEqual({ trimmed: true, taskCount: 1 });
      expect(replay(`[human, summary, { type:"message", role:"user", id:"new-steering", content:"NEW_STEERING", internal_chat_message_metadata_passthrough:{turn_id:identity.turnId} }]`))
        .toMatchObject({ status: "accepted", source: "NEW_STEERING" });
      expect(replay("[human, summary]")).toMatchObject({
        status: "rejected", code: "compaction_source_unavailable", httpStatus: 409,
      });
      expect(replay("[summary]")).toMatchObject({
        status: "rejected", code: "compaction_source_unavailable", httpStatus: 409,
      });
      expect(probe(`
        ChatGptBrowserWorker.prototype.run = () => { throw new Error("No browser work is allowed for missing task provenance"); };
        const response = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
          method:"POST", body:JSON.stringify({...body, model:"chatgpt-web/gpt-6-sol", input:[human,summary]})
        }), defaultConfig("full"));
        const text = await response.text(), result=JSON.parse(text);
        console.log(JSON.stringify({httpStatus:response.status, code:result.error?.code, message:result.error?.message,
          leakedInput:text.includes(taskText)||text.includes(human.content), summaryProduced:Array.isArray(result.output)}));
      `)).toMatchObject({ httpStatus: 409, code: "compaction_source_unavailable", leakedInput: false, summaryProduced: false });
      const legacy = JSON.parse(snapshot);
      for (const [, checkpoint] of legacy.checkpoints) delete checkpoint.sourceWasSyntheticInstruction;
      writeFileSync(path, JSON.stringify(legacy));
      expect(replay("[human, summary]")).toMatchObject({
        status: "rejected", code: "compaction_source_unavailable", httpStatus: 409,
      });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 15_000);
}
