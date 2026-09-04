const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");

test("MCP guide renders the shipped MP4 tutorials with upstream expansion controls", () => {
  const app = read("App.tsx");
  assert.ok(app.includes("./assets/mcp-create-tunnel.mp4"));
  assert.ok(app.includes("./assets/mcp-connect-connector.mp4"));
  assert.ok(app.includes("<TutorialVideo"));
  assert.ok(!app.includes("./assets/mcp-create-tunnel.gif"));
  const video = read("tutorial-video.tsx");
  for (const contract of ['<video', 'autoPlay', 'loop', 'muted', 'playsInline',
    'createPortal(', 'event.key === "Escape"', 'expandedAt.current', 'role="dialog"',
    'copy.expandGuideVideo', 'copy.closeGuideVideo']) {
    assert.ok(video.includes(contract), contract);
  }
  assert.ok(read("styles.css").includes(".guide-media video"));
  assert.match(video, /<Icon name="expand"/);
  assert.match(video, /event\.currentTarget\.currentTime = expandedAt\.current/);
  assert.match(video, /inlineVideo\.current\.currentTime = currentTime \?\? 0/);
  assert.match(read("styles.css"), /\.guide-media\.is-expanded\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
});
