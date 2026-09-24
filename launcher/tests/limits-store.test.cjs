const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LimitsStore, LimitsStoreError, OFFICIAL_LIMITS, SOURCE_URL, SOURCE_DATE, DAY_MS, RETENTION_MS, STORE_BOUNDS,
} = require("../electron/limits-store.cjs");

const A = "a".repeat(64);
const B = "b".repeat(64);
const START = Date.UTC(2026, 8, 19);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-limits-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "limits.json");
  let time = START;
  const now = () => time;
  return { root, file, now, setTime(value) { time = value; }, store: new LimitsStore(file, { now }) };
}
const receipt = (id, model = "gpt-6-pro", at = START, accountKey = A) => ({ id, model, at, accountKey });
const counts = snapshot => snapshot.windows.map(({ id, durationMs, limit, used, uncertainUsed }) => ({ id, durationMs, limit, used, uncertainUsed }));

test("opt-in, private atomic persistence, restart dedup, and receipt-only storage", t => {
  const { root, file, now, store, setTime } = fixture(t);
  assert.deepEqual(store.snapshot(), {
    enabled: false, plan: null, trackingSince: null, checkedAt: null,
    totalMessages: 0, unknownProMessages: 0, incomplete: false, windows: [],
  });
  assert.equal(store.matchesAccount(A), false);
  assert.equal(store.record(receipt("before-opt-in")), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.configure({ accountKey: A.toUpperCase(), plan: "pro_200" }).enabled, true);
  assert.equal(store.record({ ...receipt("first"), prompt: "private-prompt", email: "private-email", cookies: "private-cookie" }), true);
  assert.equal(store.record(receipt("non-pro", "other")), true);
  setTime(START + 100);
  const restarted = new LimitsStore(file, { now });
  assert.equal(restarted.matchesAccount(A.toUpperCase()), true);
  assert.equal(restarted.matchesAccount(B), false);
  assert.equal(restarted.matchesAccount(null), false);
  assert.equal(restarted.record(receipt("first", "pro-unknown", now())), false);
  const snapshot = restarted.configure({ accountKey: A, plan: "pro_200" });
  assert.equal(snapshot.trackingSince, START);
  assert.equal(snapshot.checkedAt, now());
  assert.equal(snapshot.totalMessages, 2);
  assert.equal(snapshot.unknownProMessages, 0);
  assert.equal(snapshot.windows[2].used, 1);
  snapshot.windows[0].limit = 999;
  assert.equal(restarted.snapshot().windows[0].limit, 200);
  const persisted = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persisted, /private-prompt|private-email|private-cookie|prompt|email|cookies/);
  assert.deepEqual(Object.keys(JSON.parse(persisted).accounts), [A]);
  assert.deepEqual(fs.readdirSync(root), ["limits.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  }
});

test("Pro reference caps share unknown usage without assigning a family or enforcing limits", t => {
  const { store } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_200" });
  for (const [id, model] of [["six", "gpt-6-pro"], ["five", "gpt-5.6-pro"], ["unknown", "pro-unknown"], ["other", "other"]]) {
    assert.equal(store.record(receipt(id, model)), true);
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.totalMessages, 4);
  assert.equal(snapshot.unknownProMessages, 1);
  assert.equal(snapshot.incomplete, true);
  assert.deepEqual(counts(snapshot), [
    { id: "gpt-6-pro-7d", durationMs: RETENTION_MS, limit: 200, used: 1, uncertainUsed: 1 },
    { id: "gpt-5.6-pro-24h", durationMs: DAY_MS, limit: 170, used: 1, uncertainUsed: 1 },
    { id: "shared-24h", durationMs: DAY_MS, limit: 200, used: 3, uncertainUsed: 1 },
  ]);
  store.configure({ accountKey: A, plan: "pro_100" });
  for (let index = 0; index < 48; index += 1) assert.equal(store.record(receipt(`extra-${index}`)), true);
  assert.deepEqual(counts(store.snapshot()), [
    { id: "shared-7d", durationMs: RETENTION_MS, limit: 50, used: 51, uncertainUsed: 1 },
  ]);
  assert.match(OFFICIAL_LIMITS.pro_100[0].label, /rolling last 7 days/);
  assert.match(OFFICIAL_LIMITS.pro_200[1].label, /rolling last 24 hours/);
  assert.equal(SOURCE_DATE, "2026-09-19");
  assert.equal(new URL(SOURCE_URL).hostname, "help.openai.com");
  assert.equal("remaining" in snapshot.windows[0], false);
  assert.equal("resetAt" in snapshot.windows[0], false);
});

test("rolling boundaries expire independently and prune receipts without losing retained dedup", t => {
  const { store, file, now, setTime } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_200" });
  store.record(receipt("old"));
  setTime(START + DAY_MS - 1);
  store.record(receipt("later", "gpt-5.6-pro", now()));
  store.record(receipt("unknown", "pro-unknown", now()));
  assert.equal(store.snapshot().windows[2].used, 3);
  setTime(START + DAY_MS);
  assert.deepEqual(store.snapshot().windows.map(window => window.used), [1, 1, 2]);
  setTime(START + RETENTION_MS);
  assert.equal(store.snapshot().totalMessages, 2);
  assert.deepEqual(store.snapshot().windows.map(window => window.used), [0, 0, 0]);
  assert.equal(store.snapshot().windows[0].uncertainUsed, 1);
  assert.equal(store.record(receipt("old")), false);
  assert.equal(store.record(receipt("later", "gpt-6-pro", now())), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).accounts[A].events.map(event => event.id), ["later", "unknown"]);
  setTime(START + RETENTION_MS + DAY_MS - 1);
  const restarted = new LimitsStore(file, { now });
  assert.equal(restarted.snapshot().totalMessages, 0);
  assert.equal(restarted.snapshot().incomplete, false);
  assert.equal(restarted.snapshot().trackingSince, START);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).accounts[A].events, []);
  assert.equal(restarted.record(receipt("later", "gpt-6-pro", now())), true);
});

test("account isolation, unsupported plans, and invalid configuration cannot pollute usage", t => {
  const { store, file, now, setTime } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_100" });
  assert.equal(store.record(receipt("same-id")), true);
  setTime(START + 10);
  const second = store.configure({ accountKey: B, plan: "pro_200" });
  assert.equal(second.totalMessages, 0);
  assert.equal(second.trackingSince, now());
  assert.equal(store.record(receipt("wrong-account", "pro-unknown", now())), false);
  assert.equal(store.record(receipt("pre-opt-in", "gpt-6-pro", START, B)), false);
  assert.equal(store.record(receipt("same-id", "gpt-5.6-pro", now(), B)), true);
  assert.equal(store.configure({ accountKey: A, plan: "pro_200" }).trackingSince, START);
  assert.equal(store.snapshot().windows[0].used, 1);
  const disabled = store.configure({ accountKey: A, plan: "unsupported" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.plan, "unsupported");
  assert.equal(disabled.totalMessages, 1);
  assert.deepEqual(disabled.windows, []);
  assert.equal(store.record(receipt("disabled", "gpt-6-pro", now())), false);
  const before = fs.readFileSync(file, "utf8");
  for (const config of [{ accountKey: A, plan: "business" }, { accountKey: "email@example.com", plan: "pro_100" }, null]) {
    assert.throws(() => store.configure(config), { code: "LIMITS_INVALID_CONFIG" });
  }
  for (const event of [receipt("bad-model", "gpt-6"), receipt("", "other"), receipt("negative", "other", -1)]) {
    assert.throws(() => store.record(event), { code: "LIMITS_INVALID_EVENT" });
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  setTime(NaN);
  assert.throws(() => store.snapshot(), { code: "LIMITS_INVALID_CLOCK" });
  setTime(START + 10);
  const C = "c".repeat(64);
  assert.equal(store.configure({ accountKey: C, plan: "unsupported" }).trackingSince, null);
  setTime(now() + 10);
  assert.equal(store.configure({ accountKey: C, plan: "pro_100" }).trackingSince, now());
  assert.equal(new LimitsStore(file, { now }).configure({ accountKey: B, plan: "pro_200" }).windows[1].used, 1);
});

test("clock skew rejects new receipts without clamping or discarding existing history", t => {
  const { store, file, now, setTime } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_200" });
  setTime(START + 100);
  store.record(receipt("recorded", "gpt-6-pro", now()));
  const before = fs.readFileSync(file, "utf8");
  setTime(START + 50);
  assert.throws(() => store.record(receipt("future", "gpt-6-pro", START + 100)), { code: "LIMITS_CLOCK_SKEW" });
  assert.equal(store.snapshot().totalMessages, 0);
  assert.equal(store.record(receipt("recorded", "gpt-6-pro", now())), false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  setTime(START - 1);
  assert.throws(() => store.record(receipt("before-clock", "gpt-6-pro", now())), { code: "LIMITS_CLOCK_SKEW" });
  setTime(START + 100);
  assert.equal(store.snapshot().totalMessages, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("corrupt and unsupported persisted data throws specific errors and remains untouched", t => {
  const { store, file, now } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_200" });
  store.record(receipt("valid"));
  const valid = fs.readFileSync(file, "utf8");
  const mutations = [
    state => { state.accounts[A].plan = "business"; },
    state => { state.activeAccountKey = B; },
    state => { state.activeAccountKey = [A]; },
    state => { state.accounts[A].initializedAt = "bad-time"; },
    state => { state.accounts[A].events.push(state.accounts[A].events[0]); },
    state => { state.accounts[A].events[0].model = "unknown-model"; },
    state => { state.accounts[A].events[0].at = -1; },
    state => { state.accounts[A].events[0].prompt = "must-not-be-preserved"; },
  ];
  const cases = [
    ["{broken", "LIMITS_CORRUPT_STATE"], ["null", "LIMITS_CORRUPT_STATE"],
    [JSON.stringify({ ...JSON.parse(valid), version: 2 }), "LIMITS_UNSUPPORTED_VERSION"],
    ...mutations.map(mutate => { const state = JSON.parse(valid); mutate(state); return [JSON.stringify(state), "LIMITS_CORRUPT_STATE"]; }),
  ];
  for (const [content, code] of cases) {
    fs.writeFileSync(file, content);
    assert.throws(() => new LimitsStore(file, { now }), error => error instanceof LimitsStoreError && error.code === code);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
  fs.truncateSync(file, STORE_BOUNDS.maxFileBytes + 1);
  assert.throws(() => new LimitsStore(file, { now }), { code: "LIMITS_CORRUPT_STATE" });
  assert.equal(fs.statSync(file).size, STORE_BOUNDS.maxFileBytes + 1);
});

test("failed atomic persistence does not advance in-memory counts or dedup state", t => {
  const { store, root, file } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_200" });
  const before = fs.readFileSync(file, "utf8");
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => store.record(receipt("retry")), { code: "LIMITS_WRITE_FAILED" });
  assert.equal(store.snapshot().totalMessages, 0);
  assert.deepEqual(fs.readdirSync(root), ["limits.json"]);
  fs.rmdirSync(file);
  fs.writeFileSync(file, before);
  assert.equal(store.record(receipt("retry")), true);
  assert.equal(store.snapshot().totalMessages, 1);
});

test("capacity fails explicitly without evicting recent receipts or account history", t => {
  const { store, file, now, setTime } = fixture(t);
  store.configure({ accountKey: A, plan: "pro_200" });
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.accounts[A].events = Array.from({ length: STORE_BOUNDS.maxEvents }, (_, index) => ({ id: `receipt-${index}`, model: "gpt-6-pro", at: START }));
  for (let index = 1; index < STORE_BOUNDS.maxAccounts; index += 1) {
    state.accounts[index.toString(16).padStart(64, "0")] = { plan: "unsupported", initializedAt: null, checkedAt: START, events: [] };
  }
  fs.writeFileSync(file, JSON.stringify(state));
  const bounded = new LimitsStore(file, { now });
  assert.equal(bounded.record(receipt("receipt-0")), false);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => bounded.record(receipt("one-too-many")), { code: "LIMITS_CAPACITY_EXCEEDED" });
  assert.throws(() => bounded.configure({ accountKey: B, plan: "pro_100" }), { code: "LIMITS_CAPACITY_EXCEEDED" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  setTime(START + RETENTION_MS);
  assert.equal(bounded.record(receipt("one-too-many", "pro-unknown", now())), true);
  assert.equal(bounded.snapshot().totalMessages, 1);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).accounts).length, STORE_BOUNDS.maxAccounts);
});
