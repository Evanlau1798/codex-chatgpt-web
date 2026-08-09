const TURN_INTERACTION_SHIELD_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
  body { display: flex; justify-content: center; align-items: flex-start; cursor: not-allowed; }
  div { margin: 12px; padding: 8px 14px; max-width: 520px; border-radius: 8px; background: rgba(20,20,20,.88); color: white; font: 13px system-ui; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
</style>
<div role="status">This conversation is controlled by Codex. Stop or send follow-up messages from Codex.</div>`)}`;

function createTurnInteractionShield(WebContentsView) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  view.setBackgroundColor("#00000000");
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return view;
}

module.exports = { createTurnInteractionShield, TURN_INTERACTION_SHIELD_URL };
