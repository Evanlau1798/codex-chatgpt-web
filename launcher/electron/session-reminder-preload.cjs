const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexSessionReminder", {
  language: () => ipcRenderer.invoke("launcher:session-reminder-language"),
  resize: height => ipcRenderer.invoke("launcher:session-reminder-height", height),
  action: action => ipcRenderer.invoke("launcher:session-reminder-action", action),
  onLanguage: listener => {
    const callback = (_, language) => listener(language);
    ipcRenderer.on("launcher:session-reminder-language-changed", callback);
    return () => ipcRenderer.removeListener("launcher:session-reminder-language-changed", callback);
  },
});
