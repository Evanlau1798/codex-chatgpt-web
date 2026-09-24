const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LimitsController } = require("../electron/limits-controller.cjs");

const A = "a".repeat(64);
const B = "b".repeat(64);
const START = Date.UTC(2026, 8, 19);
const config = (accountKey = A, plan = "pro_200") => ({ accountKey, plan });
const receipt = (id, accountKey = A, at = START) => ({ id, accountKey, at, model: "gpt-6-pro" });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-limits-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "limits.json");
  let mode = "automatic";
  let time = START;
  const options = { getInteractionMode: () => mode, now: () => time };
  return { file, options, controller: new LimitsController(file, options), setMode(value) { mode = value; }, setTime(value) { time = value; } };
}

test("lazy corrupt store is explicitly unavailable without crashing or replacing its file", async t => {
  const { file, options } = fixture(t);
  fs.writeFileSync(file, "{corrupt");
  const controller = new LimitsController(file, options);
  const snapshot = controller.snapshot();
  assert.deepEqual({ ...snapshot, error: null }, {
    enabled: false, plan: null, trackingSince: null, checkedAt: null,
    totalMessages: 0, unknownProMessages: 0, incomplete: false, windows: [], disabledReason: null, error: null,
  });
  assert.match(snapshot.error, /unavailable.*not valid JSON/);
  assert.equal(controller.enabled(), false);
  assert.equal(controller.record({ receipt: receipt("ignored") }), false);
  await assert.rejects(controller.setup(() => assert.fail("A corrupt store cannot be configured")), /not valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{corrupt");
  assert.match(controller.snapshot().error, /history may be incomplete/);
});

test("setup opts in, restores persisted counts, and preserves counters and sticky errors on failure", async t => {
  const { file, options, controller } = fixture(t);
  assert.equal(controller.enabled(), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(controller.record({ receipt: receipt("not-opted-in") }), false);
  assert.equal((await controller.setup(async () => config())).enabled, true);
  assert.equal(controller.record({ receipt: receipt("first") }), true);
  const restarted = new LimitsController(file, options);
  assert.equal(restarted.enabled(), true);
  assert.equal(restarted.record({ receipt: receipt("first") }), false);
  assert.equal(restarted.snapshot().error, null);
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(restarted.setup(async () => { throw new Error("browser busy"); }), /browser busy.*history may be incomplete/);
  await assert.rejects(restarted.setup(async () => config(B, "business")), /Expected a 64-hex/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(restarted.snapshot().totalMessages, 1);
  const error = restarted.snapshot().error;
  assert.equal(restarted.record({ receipt: receipt("second") }), true);
  assert.equal(restarted.snapshot().error, error);
  const checked = await restarted.setup(async () => config());
  assert.equal(checked.totalMessages, 2);
  assert.equal(checked.error, null);
  assert.equal(checked.disabledReason, null);
  let finishCheck;
  const pending = restarted.setup(() => new Promise(resolve => { finishCheck = resolve; }));
  await assert.rejects(restarted.setup(() => assert.fail("Only one detector may run")), /already running/);
  finishCheck(config());
  assert.equal((await pending).totalMessages, 2);
  const unsupported = await restarted.setup(async () => config(A, "unsupported"));
  assert.equal(unsupported.enabled, false);
  assert.equal(unsupported.totalMessages, 2);
  assert.equal(restarted.record({ receipt: receipt("unsupported") }), false);
});

test("Zero Risk gates setup and receipt writes, including a mode change during detection", async t => {
  const { file, controller, setMode } = fixture(t);
  await controller.setup(async () => config());
  controller.record({ receipt: receipt("saved") });
  const before = fs.readFileSync(file, "utf8");
  setMode("manual");
  assert.equal(controller.enabled(), false);
  assert.equal(controller.snapshot().disabledReason, "zero-risk");
  assert.equal(controller.snapshot().totalMessages, 1);
  assert.equal(controller.record({ receipt: receipt("manual") }), false);
  assert.equal(controller.record({ trackingError: "account-unavailable" }), false);
  await assert.rejects(controller.setup(() => assert.fail("Manual mode must not call the detector")), /Zero Risk/);
  setMode("automatic");
  await assert.rejects(controller.setup(async () => { setMode("manual"); return config(B); }), /Zero Risk/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  setMode("automatic");
  assert.equal((await controller.setup(async () => config())).error, null);
  assert.equal(controller.enabled(), true);
});

test("account mismatch and missing identity report persistent gaps without charging another account", async t => {
  const { controller } = fixture(t);
  await controller.setup(async () => config());
  assert.equal(controller.record({ receipt: receipt("first", A.toUpperCase()) }), true);
  assert.equal(controller.record({ receipt: receipt("wrong", B) }), false);
  const mismatch = controller.snapshot().error;
  assert.match(mismatch, /does not match.*not counted.*history may be incomplete.*Check your plan again/);
  assert.equal(controller.snapshot().totalMessages, 1);
  assert.equal(controller.record({ receipt: receipt("first") }), false);
  assert.equal(controller.record({ receipt: receipt("second") }), true);
  assert.equal(controller.snapshot().error, mismatch);
  assert.equal(controller.enabled(), true);
  assert.equal(controller.record({ trackingError: "account-unavailable", receipt: receipt("ambiguous") }), false);
  assert.match(controller.snapshot().error, /exactly one submission/);
  assert.equal(controller.record({ trackingError: "account-unavailable" }), false);
  const gap = controller.snapshot().error;
  assert.match(gap, /could not be identified.*history may be incomplete/);
  assert.equal(controller.record({ receipt: receipt("third") }), true);
  assert.equal(controller.snapshot().error, gap);
  const nextAccount = await controller.setup(async () => config(B));
  assert.equal(nextAccount.totalMessages, 0);
  assert.equal(nextAccount.error, null);
  assert.equal(controller.record({ receipt: receipt("first", B) }), true);
  assert.equal((await controller.setup(async () => config())).totalMessages, 3);
});

test("optional receipt failures never throw or erase counters and only a recheck clears their error", async t => {
  const { file, controller, setTime } = fixture(t);
  await controller.setup(async () => config());
  assert.equal(controller.record({ receipt: receipt("saved") }), true);
  assert.equal(controller.record({ receipt: receipt("future", A, START + 1) }), false);
  assert.match(controller.snapshot().error, /ahead of the local clock.*history may be incomplete/);
  const before = fs.readFileSync(file, "utf8");
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.equal(controller.record({ receipt: receipt("retry") }), false);
  assert.match(controller.snapshot().error, /Could not save/);
  assert.equal(controller.snapshot().totalMessages, 1);
  fs.rmdirSync(file);
  fs.writeFileSync(file, before);
  const error = controller.snapshot().error;
  assert.equal(controller.record({ receipt: receipt("retry") }), true);
  assert.equal(controller.snapshot().error, error);
  assert.equal((await controller.setup(async () => config())).totalMessages, 2);
  setTime(NaN);
  assert.equal(controller.record({ receipt: receipt("invalid-clock") }), false);
  assert.equal(controller.snapshot().enabled, false);
  assert.equal(controller.snapshot().plan, null);
  assert.match(controller.snapshot().error, /clock/);
  setTime(START);
  assert.equal(controller.snapshot().totalMessages, 2);
  assert.match(controller.snapshot().error, /clock/);
  assert.equal((await controller.setup(async () => config())).error, null);
});
