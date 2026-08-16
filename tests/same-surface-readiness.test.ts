import { expect, test } from "bun:test";
import {
  chatGptCompletionEvidenceFailure,
  chatGptSameSurfaceReadiness,
  type ChatGptSameSurfaceEvidence,
} from "../src/adapters/chatgpt-web/same-surface-readiness";

const healthyEvidence = (): ChatGptSameSurfaceEvidence => ({
  responsePresent: true,
  bindingPresent: true,
  completionActionVisible: false,
  globalCompletionActionVisible: false,
  composerVisibleCount: 1,
  composerTextChars: [0],
  running: false,
  aborted: false,
});

test("same-surface retry requires one empty composer on the bound response", () => {
  expect(chatGptSameSurfaceReadiness(healthyEvidence())).toEqual({
    eligible: true,
    reason: "eligible",
  });
  expect(chatGptSameSurfaceReadiness({ ...healthyEvidence(), responsePresent: false }))
    .toEqual({ eligible: false, reason: "response_missing" });
  expect(chatGptSameSurfaceReadiness({ ...healthyEvidence(), bindingPresent: false }))
    .toEqual({ eligible: false, reason: "binding_missing" });
  expect(chatGptSameSurfaceReadiness({ ...healthyEvidence(), composerVisibleCount: 2, composerTextChars: [0, 0] }))
    .toEqual({ eligible: false, reason: "composer_ambiguous" });
  expect(chatGptSameSurfaceReadiness({ ...healthyEvidence(), composerTextChars: [17] }))
    .toEqual({ eligible: false, reason: "composer_not_empty" });
});

test("same-surface retry rejects completion evidence belonging to another turn", () => {
  expect(chatGptSameSurfaceReadiness({
    ...healthyEvidence(),
    globalCompletionActionVisible: true,
  })).toEqual({ eligible: false, reason: "completion_action_conflict" });
});

test("completion evidence failures retire structurally mismatched surfaces", () => {
  const retained = chatGptCompletionEvidenceFailure("missing action", false, healthyEvidence());
  expect(retained.readiness).toEqual({ eligible: true, reason: "eligible" });
  expect(retained.error).toMatchObject({
    code: "chatgpt_completion_evidence_missing",
    retireSession: false,
  });

  const retired = chatGptCompletionEvidenceFailure("missing action", false, {
    ...healthyEvidence(),
    globalCompletionActionVisible: true,
  });
  expect(retired.readiness).toEqual({ eligible: false, reason: "completion_action_conflict" });
  expect(retired.error).toMatchObject({ code: "chatgpt_surface_changed", retireSession: true });
});

test("same-surface retry rejects active or aborted generations", () => {
  expect(chatGptSameSurfaceReadiness({ ...healthyEvidence(), running: true }))
    .toEqual({ eligible: false, reason: "generation_running" });
  expect(chatGptSameSurfaceReadiness({ ...healthyEvidence(), aborted: true }))
    .toEqual({ eligible: false, reason: "aborted" });
});
