const { configureChatGptAnnouncementDismissal } = require("./browser-announcements.cjs");

async function markTurnTabSurface(host, tab, viewportCss) {
  const contents = tab.view.webContents;
  if (contents.isDestroyed() || host.turnTabs.get(tab.id) !== tab) {
    throw new Error("Browser closed before surface ownership was established");
  }
  await contents.insertCSS(viewportCss).catch(() => {});
  const encoded = JSON.stringify(tab.surfaceId);
  await contents.executeJavaScript(`(() => {
    Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
      value: ${encoded}, configurable: true, enumerable: false, writable: false,
    });
    document.documentElement.dataset.codexWebGptSurface = ${encoded};
    (${configureChatGptAnnouncementDismissal.toString()})(true);
  })()`, true);
  if (contents.isDestroyed() || host.turnTabs.get(tab.id) !== tab) {
    throw new Error("Browser closed while surface ownership was being established");
  }
}

function initializeAutomaticTurnTab(host, tab, loadCommittedSurface, idleUrl, viewportCss, signal) {
  tab.initializingSurface = true;
  tab.initialization = (async () => {
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      signal?.throwIfAborted();
      await Promise.race([(async () => {
        await loadCommittedSurface(tab.view.webContents, idleUrl);
        signal?.throwIfAborted();
        await markTurnTabSurface(host, tab, viewportCss);
      })(), aborted]);
      signal?.throwIfAborted();
      tab.initializingSurface = false;
      return tab;
    } catch (error) {
      host.logger.error("browser.tab_initialization_failed", {
        tabId: tab.id, traceId: tab.traceId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (host.turnTabs.get(tab.id) === tab) host.removeTurnTab(tab, true);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  })();
  return tab.initialization;
}

module.exports = { initializeAutomaticTurnTab, markTurnTabSurface };
