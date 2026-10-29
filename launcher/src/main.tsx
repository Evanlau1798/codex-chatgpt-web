import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SessionReminderOverlay } from "./SessionReminderOverlay";
import "./tokens.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.codexSessionReminder ? <SessionReminderOverlay /> : <App />}
  </React.StrictMode>,
);
