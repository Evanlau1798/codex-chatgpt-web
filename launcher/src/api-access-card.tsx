import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { messageOf } from "./app-shared";
import type { Copy } from "./i18n";
import type { ApiAccessStatus } from "./types";

const api = window.codexWebLauncher;

export function ApiAccessCard({ copy, configured, setError }: {
  copy: Copy;
  configured: boolean;
  setError: (error: string | null) => void;
}) {
  const [status, setStatus] = useState<ApiAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState<"endpoint" | "key" | null>(null);

  useEffect(() => {
    if (!configured) { setStatus(null); return; }
    let cancelled = false;
    void api!.apiAccessStatus()
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch((cause) => { if (!cancelled) setError(messageOf(cause)); });
    return () => { cancelled = true; };
  }, [configured, setError]);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const change = async (operation: () => Promise<ApiAccessStatus>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConfirmReset(false);
    try { setStatus(await operation()); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const copyValue = async (kind: "endpoint" | "key") => {
    try {
      if (kind === "endpoint") await api!.copyApiAccessEndpoint();
      else await api!.copyApiAccessKey();
      setCopied(kind);
    } catch (cause) { setError(messageOf(cause)); }
  };
  const enabled = status?.state !== "disabled" && status !== null;
  const stateLabel = status?.state === "enabled" ? copy.apiAccessEnabled
    : status?.state === "key_required" ? copy.apiAccessKeyRequired : copy.apiAccessDisabled;

  return <div className="settings-card api-access-card">
    <header className="settings-card-header">
      <div>
        <strong>{copy.apiAccess}</strong>
        <p>{copy.apiAccessSummary}</p>
      </div>
      <div className="api-access-controls">
        <span className={`api-access-indicator is-${status?.state ?? "disabled"}`} aria-live="polite">{stateLabel}</span>
        <button
          aria-checked={enabled}
          aria-label={copy.apiAccessToggle}
          className={`switch${enabled ? " is-on" : ""}`}
          disabled={!configured || !status || busy}
          onClick={() => void change(() => api!.setApiAccessEnabled(!enabled))}
          role="switch"
          type="button"
        ><span /></button>
      </div>
    </header>
    <div className="settings-card-divider" />
    <div className="api-access-grid">
      <div className="account-safety-field">
        <strong>{copy.apiAccessEndpoint}</strong>
        <small>{copy.apiAccessEndpointBody}</small>
        <div className="account-safety-input api-access-input">
          <input aria-label={copy.apiAccessEndpoint} readOnly spellCheck={false} type="text" value={status?.endpoint ?? ""} />
          <button aria-label={copy.apiAccessCopyEndpoint} disabled={!status} onClick={() => void copyValue("endpoint")} title={copy.apiAccessCopyEndpoint} type="button"><Icon name="copy" /></button>
        </div>
      </div>
      <div className="account-safety-field">
        <strong>{copy.apiAccessKey}</strong>
        <small>{copy.apiAccessKeyBody}</small>
        <div className="account-safety-input api-access-input">
          <input aria-label={copy.apiAccessKey} placeholder={copy.apiAccessNoKey} readOnly spellCheck={false} type="text" value={status?.keyPreview ?? ""} />
          {status?.hasKey ? <button aria-label={copy.apiAccessCopyKey} disabled={busy} onClick={() => void copyValue("key")} title={copy.apiAccessCopyKey} type="button"><Icon name="copy" /></button> : null}
        </div>
      </div>
      <div className="api-access-action">
        {status?.hasKey ? <button
          className={`account-safety-action account-safety-reset-action${confirmReset ? " is-confirm" : ""}`}
          disabled={busy}
          onClick={() => confirmReset ? void change(() => api!.resetApiAccessKey()) : setConfirmReset(true)}
          type="button"
        >{confirmReset ? copy.apiAccessConfirmReset : copy.apiAccessResetKey}</button>
          : <button className="account-safety-action" disabled={busy || status?.state !== "key_required"} onClick={() => void change(() => api!.generateApiAccessKey())} type="button">{copy.apiAccessGenerateKey}</button>}
      </div>
    </div>
    <span className="api-access-feedback" role="status">{copied ? copy.apiAccessCopied : ""}</span>
  </div>;
}
