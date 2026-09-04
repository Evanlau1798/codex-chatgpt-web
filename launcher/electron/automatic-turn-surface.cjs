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
  })()`, true);
  if (contents.isDestroyed() || host.turnTabs.get(tab.id) !== tab) {
    throw new Error("Browser closed while surface ownership was being established");
  }
}

function initializeAutomaticTurnTab(host, tab, loadCommittedSurface, idleUrl, viewportCss) {
  tab.initializingSurface = true;
  tab.initialization = (async () => {
    try {
      await loadCommittedSurface(tab.view.webContents, idleUrl);
      await markTurnTabSurface(host, tab, viewportCss);
      tab.initializingSurface = false;
      return tab;
    } catch (error) {
      host.logger.error("browser.tab_initialization_failed", {
        tabId: tab.id, traceId: tab.traceId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (host.turnTabs.get(tab.id) === tab) host.removeTurnTab(tab, true);
      throw error;
    }
  })();
  return tab.initialization;
}

module.exports = { initializeAutomaticTurnTab, markTurnTabSurface };
