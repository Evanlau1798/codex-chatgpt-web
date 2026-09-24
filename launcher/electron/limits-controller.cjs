const { LimitsStore } = require("./limits-store.cjs");

const HISTORY_WARNING = "Local history may be incomplete. Check your plan again.";
const emptySnapshot = () => ({
  enabled: false, plan: null, trackingSince: null, checkedAt: null,
  totalMessages: 0, unknownProMessages: 0, incomplete: false, windows: [],
});
const describe = cause => cause instanceof Error ? cause.message : "Unknown Limits error.";

class LimitsController {
  #filePath;
  #getInteractionMode;
  #now;
  #store = null;
  #error = null;
  #settingUp = false;

  constructor(filePath, { getInteractionMode, now } = {}) {
    this.#filePath = filePath;
    this.#getInteractionMode = getInteractionMode;
    this.#now = now;
  }

  #mode() {
    const mode = this.#getInteractionMode();
    if (mode !== "automatic" && mode !== "manual") throw new Error("Limits requires a valid browser interaction mode.");
    return mode;
  }

  #getStore() {
    // A corrupt optional store must not prevent launcher startup. A failed read
    // leaves this null, so a later explicit repair can be checked without a restart.
    this.#store ??= new LimitsStore(this.#filePath, { now: this.#now });
    return this.#store;
  }

  snapshot() {
    let disabledReason = null;
    try {
      disabledReason = this.#mode() === "manual" ? "zero-risk" : null;
      const snapshot = this.#getStore().snapshot();
      return { ...snapshot, enabled: snapshot.enabled && disabledReason === null, disabledReason, error: this.#error };
    } catch (cause) {
      this.#error = `Limits tracking is unavailable. ${describe(cause)} ${HISTORY_WARNING}`;
      return { ...emptySnapshot(), disabledReason, error: this.#error };
    }
  }

  enabled() {
    return this.snapshot().enabled;
  }

  #requireAutomatic() {
    if (this.#mode() !== "automatic") throw new Error("Limits is unavailable in Zero Risk mode. Switch to Automatic to check your plan.");
  }

  async setup(detectPlan) {
    if (this.#settingUp) throw new Error("A Limits plan check is already running.");
    this.#settingUp = true;
    try {
      this.#requireAutomatic();
      const store = this.#getStore();
      const config = await detectPlan();
      // The mode may have changed while the browser detector was running.
      this.#requireAutomatic();
      const snapshot = store.configure(config);
      this.#error = null;
      return { ...snapshot, disabledReason: null, error: null };
    } catch (cause) {
      this.#error = `Could not check the ChatGPT plan. ${describe(cause)} ${HISTORY_WARNING}`;
      throw new Error(this.#error, { cause });
    } finally {
      this.#settingUp = false;
    }
  }

  // Optional telemetry must never fail generation. A later successful receipt or
  // read cannot fill a missed send, so only a successful setup check clears errors.
  record({ receipt, trackingError } = {}) {
    try {
      if (this.#mode() !== "automatic") return false;
      const store = this.#getStore();
      if (!store.snapshot().enabled) return false;
      if ((receipt !== undefined) === (trackingError !== undefined)) {
        throw new Error("Expected exactly one submission receipt or tracking error.");
      }
      if (trackingError === "account-unavailable") {
        this.#error = `The ChatGPT account could not be identified for a sent message. ${HISTORY_WARNING}`;
        return false;
      }
      if (trackingError !== undefined) throw new Error("Unrecognized Limits tracking error.");
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Invalid Limits submission receipt.");
      if (!store.matchesAccount(receipt.accountKey)) {
        this.#error = `The ChatGPT account does not match the checked account. This message was not counted. ${HISTORY_WARNING}`;
        return false;
      }
      return store.record(receipt);
    } catch (cause) {
      this.#error = `Could not record launcher usage. ${describe(cause)} ${HISTORY_WARNING}`;
      return false;
    }
  }
}

module.exports = { LimitsController };
