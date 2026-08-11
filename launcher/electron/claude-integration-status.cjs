const fs = require("node:fs");
const { readJsonFile } = require("./json-file.cjs");

const CLAUDE_STEERING_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"];

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inspectClaudeIntegrationStatus({ journalPath, settingsPath }) {
  const journalExists = fs.existsSync(journalPath);
  const settingsExists = fs.existsSync(settingsPath);
  if (!journalExists) return "missing";
  if (!settingsExists) return "outdated";
  try {
    const journal = readJsonFile(journalPath);
    const settings = readJsonFile(settingsPath);
    const installed = journal?.installed;
    const hook = installed?.hook;
    const events = installed?.hookEvents;
    const brief = installed?.env?.CLAUDE_CODE_BRIEF;
    if (!hook || typeof hook !== "object" || Array.isArray(hook)
      || !Array.isArray(events)
      || !CLAUDE_STEERING_HOOK_EVENTS.every(event => events.includes(event))
      || brief !== "1"
      || settings?.env?.CLAUDE_CODE_BRIEF !== brief) {
      return "outdated";
    }
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "outdated";
    return CLAUDE_STEERING_HOOK_EVENTS.every(event => (
      Array.isArray(hooks[event]) && hooks[event].some(entry => same(entry, hook))
    )) ? "current" : "outdated";
  } catch {
    return "outdated";
  }
}

function reconcileClaudeSetupState(status) {
  return {
    claudeSetupComplete: status === "current",
    claudeSetupOutdated: status === "outdated",
  };
}

module.exports = {
  CLAUDE_STEERING_HOOK_EVENTS,
  inspectClaudeIntegrationStatus,
  reconcileClaudeSetupState,
};
