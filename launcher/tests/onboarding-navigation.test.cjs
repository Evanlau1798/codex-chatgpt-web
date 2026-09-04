const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("onboarding Back visits interaction selection before language", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  assert.ok(source.includes('setStage(isInteraction ? "language" : "interaction")'));
});
