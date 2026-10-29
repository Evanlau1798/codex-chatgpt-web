import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SessionRefreshReminder } from "./App";
import { copyFor } from "./i18n";
import type { Language } from "./types";

export function SessionReminderOverlay() {
  const api = window.codexSessionReminder!;
  const [language, setLanguage] = useState<Language | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api.language().then(setLanguage);
    return api.onLanguage(setLanguage);
  }, [api]);
  useLayoutEffect(() => {
    if (!root.current || !language) return;
    document.documentElement.lang = language;
    const element = root.current;
    const measure = () => void api.resize(element.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [api, language]);
  const act = async (action: "dismiss" | "logout") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await api.action(action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  if (!language) return null;
  return <div className="session-reminder-overlay" data-theme="dark" ref={root}>
    <SessionRefreshReminder busy={busy} copy={copyFor(language)}
      onDismiss={() => void act("dismiss")} onLogout={() => void act("logout")} />
    {error ? <p className="session-reminder-error" role="alert">{error}</p> : null}
  </div>;
}
