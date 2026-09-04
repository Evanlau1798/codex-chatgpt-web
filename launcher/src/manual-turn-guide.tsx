import { useEffect, useState } from "react";
import type { Copy } from "./i18n";
import type { BrowserTabState } from "./types";

export function ManualTurnGuide({ copy, tab, onCopy, onSent }: {
  copy: Copy;
  tab: BrowserTabState;
  onCopy: () => void;
  onSent: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const waiting = tab.manualState === "awaiting-user";
  const pending = waiting || tab.manualState === "sent";
  const deadline = tab.manualDeadlineAt ? Date.parse(tab.manualDeadlineAt) : Number.NaN;
  useEffect(() => {
    if (!pending || !Number.isFinite(deadline)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [tab.id, pending, deadline]);
  if (!pending) return null;
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1_000)) : null;
  return (
    <div className={`manual-turn-guide${waiting ? " is-waiting" : ""}`}>
      <div>
        <strong>{waiting ? copy.manualPromptTitle : copy.manualPromptWaiting}</strong>
        {waiting ? <p>{copy.manualPromptInstruction}</p> : null}
      </div>
      <span className="manual-turn-status">{seconds === null ? "" : `${seconds} ${copy.manualPromptSeconds}`}</span>
      <div className="manual-turn-actions">
        <button className="button-secondary" disabled={!waiting || !tab.canCopyPrompt} onClick={onCopy} type="button">
          <span>{copy.manualPromptCopy}</span>
        </button>
        <button className="button-primary" disabled={!waiting || !tab.canConfirmSent} onClick={onSent} type="button">
          {copy.manualPromptSent}
        </button>
      </div>
    </div>
  );
}
