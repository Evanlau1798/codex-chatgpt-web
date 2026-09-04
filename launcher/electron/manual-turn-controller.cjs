const { createHash } = require("node:crypto");
const { processRunning } = require("./process-tree.cjs");

const MAX_PROMPT_CHARS = 2_000_000;
const MAX_TERMINALS = 256;
const SUBMIT_TIMEOUT_MS = 180_000;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class ManualTurnController {
  constructor({ clipboard, host, logger }) {
    this.clipboard = clipboard;
    this.host = host;
    this.logger = logger;
    this.terminals = new Map();
  }

  find(traceId) {
    return [...this.host.turnTabs.values()].find(tab => tab.traceId === traceId);
  }

  reap(tab) {
    if (processRunning(tab.helperPid)) return;
    this.logger.warn("browser.manual_orphan_turn_reaped", {
      tabId: tab.id, traceId: tab.traceId, helperPid: tab.helperPid, evidence: "owner_process_exited",
    });
    this.removed(tab, "failed");
    this.host.removeTurnTab(tab, true);
  }

  validateOwner(traceId, helperPid) {
    const tab = this.find(traceId);
    if (!tab || tab.interactionMode !== "manual" || tab.helperPid !== helperPid) {
      throw new Error(`Zero Risk turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    return tab;
  }

  remember(traceId, helperPid, status) {
    this.terminals.delete(traceId);
    this.terminals.set(traceId, { helperPid, status });
    while (this.terminals.size > MAX_TERMINALS) this.terminals.delete(this.terminals.keys().next().value);
  }

  notify(waiters, value) {
    for (const resolve of waiters ?? []) resolve(value);
    waiters?.clear();
  }

  arm(tab) {
    if (tab.manualTimer) clearTimeout(tab.manualTimer);
    tab.manualDeadlineAt = Date.now() + SUBMIT_TIMEOUT_MS;
    tab.manualTimer = setTimeout(() => {
      if (!this.host.turnTabs.has(tab.id)) return;
      tab.manualState = "timed-out";
      this.removed(tab, "timeout");
      this.host.removeTurnTab(tab, true);
      this.logger.warn("browser.manual_turn_timed_out", { traceId: tab.traceId });
    }, SUBMIT_TIMEOUT_MS);
    tab.manualTimer.unref?.();
  }

  prepare(tab, prompt, reused) {
    Object.assign(tab, {
      interactionMode: "manual",
      interactionLocked: false,
      manualState: "awaiting-user",
      manualWaiters: new Set(),
      manualTerminalWaiters: new Set(),
      manualConversationReused: reused,
      prompt,
      promptDigest: digest(prompt),
      sentAt: null,
      message: "Paste the copied prompt, add images yourself, choose a model and effort, then press Sent",
    });
    this.arm(tab);
    this.host.presentManualTurn?.(tab);
    return {
      tabId: tab.id,
      reused,
      deadlineAt: new Date(tab.manualDeadlineAt).toISOString(),
      state: tab.manualState,
    };
  }

  begin(traceId, helperPid, prompt, conversationKey, resumePrompt) {
    if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw new Error("Manual prompt size is invalid");
    }
    if (resumePrompt !== undefined && (typeof resumePrompt !== "string"
      || resumePrompt.length < 1 || resumePrompt.length > MAX_PROMPT_CHARS)) {
      throw new Error("Manual resume prompt size is invalid");
    }
    const terminal = this.terminals.get(traceId);
    if (terminal?.helperPid === helperPid) {
      throw Object.assign(new Error(`Zero Risk turn ${traceId} was already ${terminal.status}`), {
        code: terminal.status === "timeout" ? "manual_turn_timed_out" : "turn_cancelled",
      });
    }
    const existing = this.find(traceId);
    if (existing) {
      if (existing.interactionMode !== "manual" || existing.helperPid !== helperPid) {
        throw new Error(`Zero Risk turn ${traceId} is owned by another process`);
      }
      const retry = existing.manualConversationReused ? resumePrompt : prompt;
      if (typeof retry !== "string" || digest(retry) !== existing.promptDigest) {
        throw new Error(`Zero Risk turn ${traceId} was retried with a different prompt`);
      }
      this.host.presentManualTurn?.(existing);
      return { tabId: existing.id, reused: true, state: existing.manualState,
        deadlineAt: existing.manualDeadlineAt ? new Date(existing.manualDeadlineAt).toISOString() : null };
    }
    const retained = conversationKey
      ? [...this.host.turnTabs.values()].filter(tab => tab.interactionMode === "manual"
          && tab.status === "ready" && tab.conversationKey === conversationKey)
      : [];
    if (retained.length > 1) throw new Error("Zero Risk conversation ownership is ambiguous");
    if (retained[0]) {
      if (typeof resumePrompt !== "string" || !resumePrompt) {
        throw new Error("A retained Zero Risk conversation requires an incremental resume prompt");
      }
      this.clipboard.writeText(resumePrompt);
      Object.assign(retained[0], { traceId, helperPid, status: "running" });
      return this.prepare(retained[0], resumePrompt, true);
    }
    this.clipboard.writeText(prompt);
    return this.prepare(this.host.createManualTurnTab(traceId, helperPid, conversationKey, prompt), prompt, false);
  }

  async wait(tab, setName, timeoutMs) {
    return await new Promise(resolve => {
      let timer;
      const finish = value => {
        clearTimeout(timer);
        tab[setName].delete(finish);
        resolve(value);
      };
      timer = setTimeout(() => finish({ status: "pending" }), timeoutMs);
      timer.unref?.();
      tab[setName].add(finish);
    });
  }

  waitSent(traceId, helperPid, timeoutMs = 35_000) {
    const terminal = this.terminals.get(traceId);
    if (terminal?.helperPid === helperPid) return Promise.resolve({ status: terminal.status });
    const tab = this.validateOwner(traceId, helperPid);
    if (["sent", "running", "completed"].includes(tab.manualState)) {
      return Promise.resolve({ status: "sent", sentAt: tab.sentAt });
    }
    return this.wait(tab, "manualWaiters", timeoutMs);
  }

  waitTerminal(traceId, helperPid, timeoutMs = 35_000) {
    const terminal = this.terminals.get(traceId);
    if (terminal?.helperPid === helperPid) return Promise.resolve({ status: terminal.status });
    return this.wait(this.validateOwner(traceId, helperPid), "manualTerminalWaiters", timeoutMs);
  }

  copy(tabId) {
    const tab = this.host.turnTabs.get(tabId);
    if (!tab || tab.interactionMode !== "manual" || !tab.prompt) throw new Error("Manual prompt is unavailable");
    this.clipboard.writeText(tab.prompt);
    return this.host.snapshot();
  }

  confirmSent(tabId) {
    const tab = this.host.turnTabs.get(tabId);
    if (!tab || tab.interactionMode !== "manual") throw new Error("Zero Risk tab does not exist");
    if (tab.manualState !== "awaiting-user") {
      if (["sent", "running", "completed"].includes(tab.manualState)) return this.host.snapshot();
      throw new Error("Zero Risk turn can no longer be marked as sent");
    }
    tab.manualState = "sent";
    tab.sentAt = new Date().toISOString();
    tab.prompt = null;
    tab.message = "Prompt sent; waiting for the Codex harness";
    this.arm(tab);
    this.notify(tab.manualWaiters, { status: "sent", sentAt: tab.sentAt });
    this.host.publishState?.(this.host.snapshot());
    return this.host.snapshot();
  }

  started(traceId, helperPid) {
    const tab = this.validateOwner(traceId, helperPid);
    if (tab.manualState !== "sent" && tab.manualState !== "running") {
      throw new Error(`Zero Risk turn ${traceId} was not confirmed as sent`);
    }
    clearTimeout(tab.manualTimer);
    Object.assign(tab, { manualState: "running", manualDeadlineAt: null, message: "ChatGPT is working" });
    this.host.publishState?.(this.host.snapshot());
    return this.host.snapshot();
  }

  end(traceId, helperPid, status, retain = false) {
    const tab = this.validateOwner(traceId, helperPid);
    if (status === "completed" && !["sent", "running"].includes(tab.manualState)) {
      throw new Error(`Zero Risk turn ${traceId} cannot complete before Sent confirmation`);
    }
    clearTimeout(tab.manualTimer);
    if (status === "completed" && retain && tab.conversationKey) {
      Object.assign(tab, {
        manualState: "completed", status: "ready", prompt: null, promptDigest: null,
        lastHeartbeatAt: Date.now(),
      });
      this.host.publishState?.(this.host.snapshot());
      return { cancelledByUser: false };
    }
    this.removed(tab, status === "aborted" ? "cancelled" : status);
    this.host.removeTurnTab(tab, false);
    return { cancelledByUser: status === "aborted" };
  }

  cancel(traceId, helperPid) {
    const tab = this.validateOwner(traceId, helperPid);
    this.removed(tab, "cancelled");
    this.host.removeTurnTab(tab, true);
    return { cancelledByUser: true };
  }

  removed(tab, status = "cancelled") {
    if (tab.interactionMode !== "manual") return;
    if (tab.manualTerminalStatus) return;
    tab.manualTerminalStatus = status;
    clearTimeout(tab.manualTimer);
    this.remember(tab.traceId, tab.helperPid, status);
    this.notify(tab.manualWaiters, { status });
    this.notify(tab.manualTerminalWaiters, { status });
  }
}

module.exports = { ManualTurnController };
