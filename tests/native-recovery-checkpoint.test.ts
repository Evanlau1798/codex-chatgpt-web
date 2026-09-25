import { expect, test } from "bun:test";
import { passiveRecoveryCheckpointInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";

test("passive checkpoint asks for one control call and resumes the same Web response", () => {
  const instruction = passiveRecoveryCheckpointInstruction({
    token: "control_test", handoffId: "handoff_test",
  });
  expect(instruction).toContain("codex.control.recovery_checkpoint");
  expect(instruction).toContain("control_test");
  expect(instruction).toContain("handoff_test");
  expect(instruction).toContain("continue the same Web response");
  expect(instruction).not.toContain("Automatic Codex context compaction has started");
});
