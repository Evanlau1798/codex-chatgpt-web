// Electron can leave executeJavaScript pending when its renderer dies. Bound the
// operation in the main process and discard results from a replaced document.
function runBrowserPageScript(contents, script, timeoutMs = 10_000) {
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    return Promise.reject(new Error("ChatGPT browser renderer is unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.off("render-process-gone", onGone);
      contents.off("destroyed", onDestroyed);
      contents.off("did-start-navigation", onNavigation);
      if (error) reject(error);
      else resolve(value);
    };
    const onGone = () => finish(new Error("ChatGPT browser renderer stopped during a page check"));
    const onDestroyed = () => finish(new Error("ChatGPT browser closed during a page check"));
    const onNavigation = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) finish(new Error("ChatGPT page changed during a page check"));
    };
    const timer = setTimeout(() => finish(new Error("ChatGPT browser page check timed out")), timeoutMs);
    timer.unref?.();
    contents.on("render-process-gone", onGone);
    contents.on("destroyed", onDestroyed);
    contents.on("did-start-navigation", onNavigation);
    try {
      Promise.resolve(contents.executeJavaScript(script, true)).then(
        value => finish(null, value), error => finish(error),
      );
    } catch (error) { finish(error); }
  });
}

module.exports = { runBrowserPageScript };
