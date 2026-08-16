function showBrowserWindow(window, activate) {
  if (activate) {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    return;
  }
  if (window.isMinimized() || !window.isVisible()) window.showInactive();
}

module.exports = { showBrowserWindow };
