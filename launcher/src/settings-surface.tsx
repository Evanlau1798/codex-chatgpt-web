import languages from "../electron/languages.json";
import { useEffect, useState, type ReactNode } from "react";
import { biggerContextSwitchState } from "./context-mode";
import { Icon } from "./icons";
import { ApiAccessCard } from "./api-access-card";
import type { Copy } from "./i18n";
import {
  BrandMark,
  ContentSurface,
  DoctorSummary,
  messageOf,
  NoticeRow,
  SectionHeading,
} from "./app-shared";
import type {
  AccountSafetyStatus,
  BrowserInteractionMode,
  BrowserState,
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
} from "./types";

const api = window.codexWebLauncher;

export function SettingsSurface({
  browser,
  configureInteractionMode,
  copy,
  devProfile,
  language,
  setError,
  snapshot,
  updateState,
}: {
  browser: BrowserState | null;
  configureInteractionMode: (mode: BrowserInteractionMode) => void;
  copy: Copy;
  devProfile: boolean;
  language: Language;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnsCancelled, setTurnsCancelled] = useState(false);
  const [integrationRemoved, setIntegrationRemoved] = useState(false);
  const [maxBrowserTabs, setMaxBrowserTabs] = useState(snapshot.state.maxBrowserTabs);
  const [sessionLimitEnabled, setSessionLimitEnabled] = useState(snapshot.state.automaticWebSessionLimitEnabled);
  const [sessionLimitCount, setSessionLimitCount] = useState(snapshot.state.automaticWebSessionLimitCount);
  const [sessionLimitHours, setSessionLimitHours] = useState(snapshot.state.automaticWebSessionLimitMinutes / 60);
  const [accountSafety, setAccountSafety] = useState<AccountSafetyStatus | null>(null);
  const [accountSafetySaveRetry, setAccountSafetySaveRetry] = useState(0);
  const [resetUsageStage, setResetUsageStage] = useState<"idle" | "confirm" | "complete">("idle");
  const activeWebTurn = browser?.tabs.some(
    (tab) => tab.status === "running" && tab.interactionMode !== "manual",
  ) ?? false;

  useEffect(() => {
    setMaxBrowserTabs(snapshot.state.maxBrowserTabs);
    setSessionLimitEnabled(snapshot.state.automaticWebSessionLimitEnabled);
    setSessionLimitCount(snapshot.state.automaticWebSessionLimitCount);
    setSessionLimitHours(snapshot.state.automaticWebSessionLimitMinutes / 60);
  }, [
    snapshot.state.maxBrowserTabs,
    snapshot.state.automaticWebSessionLimitEnabled,
    snapshot.state.automaticWebSessionLimitCount,
    snapshot.state.automaticWebSessionLimitMinutes,
  ]);

  useEffect(() => {
    if (snapshot.state.browserInteractionMode !== "automatic" || snapshot.state.coreSetupComplete !== true) {
      setAccountSafety(null);
      return;
    }
    if (busy) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await api!.accountSafetyStatus();
        if (!cancelled) setAccountSafety(status);
      } catch {
        if (!cancelled) setAccountSafety(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    snapshot.state.browserInteractionMode,
    snapshot.state.coreSetupComplete,
    busy,
  ]);

  const updateLanguage = async (next: Language) => {
    try {
      updateState(await api!.setLanguage(next));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const runDoctor = async () => {
    setBusy(true);
    try {
      setDoctor(await api!.doctor());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancelTurns = async () => {
    setBusy(true);
    setError(null);
    try {
      await api!.cancelTurns();
      setTurnsCancelled(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setBridgeEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setBridgeEnabled(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setUseEnhancedWebSessionMode = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setUseEnhancedWebSessionMode(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setUseEnhancedOutputTunnel = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try { updateState(await api!.setUseEnhancedOutputTunnel(enabled)); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const applyAccountSafetySettings = async () => {
    if (activeWebTurn) return;
    setBusy(true);
    setError(null);
    try {
      const automaticWebSessionLimitMinutes = Math.round(sessionLimitHours * 60);
      updateState(await api!.setAccountSafetySettings({
        maxBrowserTabs,
        ...(sessionLimitEnabled ? {
          automaticWebSessionLimitCount: sessionLimitCount,
          automaticWebSessionLimitMinutes,
        } : {}),
      }));
      setAccountSafety(await api!.accountSafetyStatus());
    } catch (cause) {
      setAccountSafetySaveRetry((retry) => retry + 1);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const recoverAccountSafety = async (action: "resume" | "acknowledge") => {
    if (activeWebTurn) return;
    setBusy(true);
    setError(null);
    try {
      setAccountSafety(action === "resume"
        ? await api!.resumeAutomaticWeb()
        : await api!.acknowledgeAccountSafetyStop());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const resetAccountSafetyUsage = async () => {
    if (activeWebTurn) return;
    if (resetUsageStage !== "confirm") {
      setResetUsageStage("confirm");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAccountSafety(await api!.resetAutomaticWebUsage());
      setResetUsageStage("complete");
    } catch (cause) {
      setResetUsageStage("idle");
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setBiggerContext = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setBiggerContext(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setSkillAttachments = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setSkillAttachments(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setExperimentalNoAutoCompact = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setExperimentalNoAutoCompact(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setManualInteraction = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api!.setBrowserInteractionMode(enabled ? "manual" : "automatic");
      if (result.credentialsRequired) {
        configureInteractionMode(result.targetMode);
        return;
      }
      updateState(result.state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const setZeroRiskPro = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateState(await api!.setZeroRiskPro(enabled));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const biggerContextState = biggerContextSwitchState({
    browserInteractionMode: snapshot.state.browserInteractionMode,
    busy,
    coreSetupComplete: snapshot.state.coreSetupComplete === true,
    useEnhancedWebSessionMode: snapshot.state.useEnhancedWebSessionMode,
    experimentalBiggerContext: snapshot.state.experimentalBiggerContext,
  });
  const accountSafetySettingsValid = Number.isInteger(maxBrowserTabs)
    && maxBrowserTabs >= 1
    && maxBrowserTabs <= 6
    && (!sessionLimitEnabled
      || (Number.isInteger(sessionLimitCount)
        && sessionLimitCount >= 1
        && sessionLimitCount <= 10_000
        && Number.isFinite(sessionLimitHours)
        && sessionLimitHours >= 0.25
        && sessionLimitHours <= 168
        && Number.isInteger(sessionLimitHours * 60)));
  const accountSafetySettingsChanged = maxBrowserTabs !== snapshot.state.maxBrowserTabs
    || sessionLimitEnabled !== snapshot.state.automaticWebSessionLimitEnabled
    || (sessionLimitEnabled && (
      sessionLimitCount !== snapshot.state.automaticWebSessionLimitCount
      || Math.round(sessionLimitHours * 60) !== snapshot.state.automaticWebSessionLimitMinutes
    ));
  useEffect(() => {
    if (snapshot.state.browserInteractionMode !== "automatic"
      || snapshot.state.coreSetupComplete !== true
      || activeWebTurn
      || busy
      || !accountSafetySettingsValid
      || !accountSafetySettingsChanged) return;
    const timer = window.setTimeout(() => void applyAccountSafetySettings(), 3_000);
    return () => window.clearTimeout(timer);
  }, [
    maxBrowserTabs,
    sessionLimitEnabled,
    sessionLimitCount,
    sessionLimitHours,
    accountSafetySettingsValid,
    accountSafetySettingsChanged,
    accountSafetySaveRetry,
    activeWebTurn,
    busy,
    snapshot.state.browserInteractionMode,
    snapshot.state.coreSetupComplete,
  ]);
  useEffect(() => {
    if (resetUsageStage === "idle") return;
    const timer = window.setTimeout(
      () => setResetUsageStage("idle"),
      resetUsageStage === "confirm" ? 5_000 : 1_800,
    );
    return () => window.clearTimeout(timer);
  }, [resetUsageStage]);
  const accountSafetyStateLabel = accountSafety ? ({
    NORMAL: copy.accountSafetyStateNormal,
    DRAINING: copy.accountSafetyStateDraining,
    PAUSED: copy.accountSafetyStatePaused,
    HARD_STOP: copy.accountSafetyStateHardStop,
  } as const)[accountSafety.state] : copy.notConfigured;
  const accountSafetyReason = accountSafety?.reason ? ({
    duration_limit: copy.accountSafetyReasonDuration,
    rate_limit: copy.accountSafetyReasonRate,
    account_security: copy.accountSafetyReasonSecurity,
  } as const)[accountSafety.reason] : null;
  const sessionCapacity = accountSafety?.session_limit ?? sessionLimitCount;
  const usedSessions = accountSafety?.used_sessions ?? 0;
  const remainingSessions = Math.max(0, sessionCapacity - usedSessions);
  const remainingPercent = sessionLimitEnabled && sessionCapacity > 0
    ? Math.min(100, (remainingSessions / sessionCapacity) * 100)
    : 0;
  const resetRemainingMs = accountSafety?.remaining_ms
    ?? (sessionLimitEnabled ? Math.round(sessionLimitHours * 60 * 60_000) : undefined);
  const accountSafetyMeterText = sessionLimitEnabled && resetRemainingMs !== undefined
    ? `${copy.accountSafetySessionsRemaining
      .replace("{remaining}", String(remainingSessions))
      .replace("{limit}", String(sessionCapacity))} · ${copy.accountSafetyResetIn
      .replace("{time}", formatSafetyResetTime(resetRemainingMs, copy))}`
    : copy.accountSafetyDisabled;
  const uninstallIntegration = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api!.uninstallIntegration();
      if (!result.cancelled) {
        updateState(result.state);
        setIntegrationRemoved(true);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface narrow title={devProfile ? copy.devSettingsTitle : copy.settingsTitle}>
      <div className="settings-card enhanced-feature-card">
        <header className="settings-card-header">
          <div><strong>{copy.enhancedFeatureSettings}</strong></div>
        </header>
        <div className="settings-card-divider" />
        <div className="settings-list">
        <SettingRow body={copy.enhancedWebSessionModeBody} label={copy.enhancedWebSessionMode}>
          <Switch
            checked={snapshot.state.useEnhancedWebSessionMode}
            disabled={busy || snapshot.state.coreSetupComplete !== true}
            onChange={(enabled) => void setUseEnhancedWebSessionMode(enabled)}
          />
        </SettingRow>
        <SettingRow body={copy.enhancedOutputTunnelBody} label={copy.enhancedOutputTunnel}>
          <Switch
            checked={snapshot.state.useEnhancedOutputTunnel}
            disabled={busy || snapshot.state.coreSetupComplete !== true
              || !snapshot.state.useEnhancedWebSessionMode || snapshot.state.browserInteractionMode !== "automatic"}
            onChange={(enabled) => void setUseEnhancedOutputTunnel(enabled)}
          />
        </SettingRow>
        <SettingRow body={copy.noAutoCompactBody} label={copy.noAutoCompact}>
          <Switch
            checked={snapshot.state.experimentalNoAutoCompact}
            disabled={busy || snapshot.state.coreSetupComplete !== true}
            onChange={(enabled) => void setExperimentalNoAutoCompact(enabled)}
          />
        </SettingRow>
        {snapshot.state.browserInteractionMode === "manual" ? (
          <SettingRow body={copy.zeroRiskModelSettingsBody} label={copy.zeroRiskModelSettings}>
            <Switch
              checked={snapshot.state.zeroRiskProEnabled}
              disabled={busy || snapshot.state.coreSetupComplete !== true}
              onChange={(enabled) => void setZeroRiskPro(enabled)}
            />
          </SettingRow>
        ) : null}
        <SettingRow body={copy.lockBrowserDuringTurnsBody} label={copy.lockBrowserDuringTurns}>
          <Switch
            checked={snapshot.state.lockBrowserDuringTurns}
            onChange={(checked) => void api!.setPreference("lockBrowserDuringTurns", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        </div>
      </div>

      {snapshot.state.browserInteractionMode === "automatic" ? <>
        <div className="settings-card account-safety-card">
          <header className="settings-card-header account-safety-card-header">
            <div>
              <strong>{copy.accountSafety}</strong>
              <p>{copy.accountSafetySummary}</p>
              {activeWebTurn ? <p role="status">{copy.accountSafetyActiveWebTurn}</p> : null}
            </div>
            <div className="account-safety-card-controls">
              <span className="account-safety-help">
                <button aria-describedby="account-safety-help" aria-label={copy.accountSafetyHelpLabel} type="button">?</button>
                <span id="account-safety-help" role="tooltip">{copy.accountSafetyBody}</span>
              </span>
              <Switch
                label={copy.accountSafetyLimitToggle}
                checked={sessionLimitEnabled}
                disabled={busy || activeWebTurn || snapshot.state.coreSetupComplete !== true}
                onChange={setSessionLimitEnabled}
              />
            </div>
          </header>

          <div className="settings-card-divider" />
          <div className="account-safety-grid">
            <label className="account-safety-field">
              <strong>{copy.automaticWebSessionLimit}</strong>
              <small>{copy.automaticWebSessionLimitBody}</small>
              <div className="account-safety-input">
                <input
                  aria-label={copy.automaticWebSessionLimit}
                  disabled={busy || activeWebTurn || !sessionLimitEnabled || snapshot.state.coreSetupComplete !== true}
                  max={10_000}
                  min={1}
                  onChange={(event) => setSessionLimitCount(Number(event.target.value))}
                  step={1}
                  type="number"
                  value={sessionLimitCount}
                />
                <span>{copy.accountSafetySessionsUnit}</span>
              </div>
            </label>
            <label className="account-safety-field">
              <strong>{copy.accountSafetyWindowHours}</strong>
              <small>{copy.accountSafetyWindowHoursBody}</small>
              <div className="account-safety-input">
                <input
                  aria-label={copy.accountSafetyWindowHours}
                  disabled={busy || activeWebTurn || !sessionLimitEnabled || snapshot.state.coreSetupComplete !== true}
                  max={168}
                  min={0.25}
                  onChange={(event) => setSessionLimitHours(Number(event.target.value))}
                  step={0.25}
                  type="number"
                  value={sessionLimitHours}
                />
                <span>{copy.accountSafetyHoursUnit}</span>
              </div>
            </label>
            <label className="account-safety-field">
              <strong>{copy.maximumConcurrentWebTurns}</strong>
              <small>{copy.maximumConcurrentWebTurnsBody}</small>
              <div className="account-safety-input">
                <input
                  aria-label={copy.maximumConcurrentWebTurns}
                  disabled={busy || activeWebTurn || snapshot.state.coreSetupComplete !== true}
                  max={6}
                  min={1}
                  onChange={(event) => setMaxBrowserTabs(Number(event.target.value))}
                  step={1}
                  type="number"
                  value={maxBrowserTabs}
                />
                <span>{copy.accountSafetyConcurrentUnit}</span>
              </div>
            </label>
          </div>

          <div className="settings-card-divider" />
          <div className="account-safety-meter">
            <div className="account-safety-meter-labels">
              <strong>{copy.accountSafetyUsageMeter}</strong>
              <span>{accountSafetyMeterText}</span>
            </div>
            <div
              aria-label={copy.accountSafetyUsageMeter}
              aria-valuemax={sessionCapacity}
              aria-valuemin={0}
              aria-valuenow={sessionLimitEnabled ? remainingSessions : 0}
              aria-valuetext={accountSafetyMeterText}
              className={`account-safety-progress${sessionLimitEnabled && remainingPercent < 20 ? " is-low" : ""}${resetUsageStage === "complete" ? " is-resetting" : ""}`}
              role="progressbar"
            >
              <span style={{ width: `${remainingPercent}%` }} />
            </div>
            <div className="account-safety-card-footer">
              <div className="account-safety-live-state">
                <strong>{accountSafetyStateLabel}</strong>
                {accountSafetyReason ? <small>{accountSafetyReason}</small> : null}
              </div>
              <div className="account-safety-actions">
                <span className="account-safety-reset">
                  <button
                    aria-describedby="account-safety-reset-hint"
                    className={`account-safety-action account-safety-reset-action${resetUsageStage === "confirm" ? " is-confirm" : ""}${resetUsageStage === "complete" ? " is-complete" : ""}`}
                    disabled={busy || activeWebTurn || usedSessions === 0 || accountSafety?.state === "DRAINING" || accountSafety?.state === "HARD_STOP"}
                    onClick={() => void resetAccountSafetyUsage()}
                    type="button"
                  >{resetUsageStage === "confirm"
                      ? copy.confirmAccountSafetyReset
                      : resetUsageStage === "complete"
                        ? copy.accountSafetyResetComplete
                        : copy.resetAccountSafetyUsage}</button>
                  <span id="account-safety-reset-hint" role="tooltip">{copy.accountSafetyResetHint}</span>
                </span>
                {accountSafety?.state === "PAUSED" && accountSafety.reason === "rate_limit" ? (
                  <button
                    className="account-safety-action"
                    disabled={busy || activeWebTurn}
                    onClick={() => void recoverAccountSafety("resume")}
                    type="button"
                  >{copy.resumeAutomaticWeb}</button>
                ) : null}
                {accountSafety?.state === "HARD_STOP" ? (
                  <button
                    className="account-safety-action"
                    disabled={busy || activeWebTurn}
                    onClick={() => void recoverAccountSafety("acknowledge")}
                    type="button"
                  >{copy.acknowledgeAccountSafetyStop}</button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <ApiAccessCard copy={copy} configured={snapshot.state.coreSetupComplete === true} setError={setError} />
      </> : null}

      <SectionHeading label={copy.general} spaced />
      <div className="settings-list">
        {!devProfile ? <SettingRow body={copy.launchAtLoginBody} label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow> : null}
        {!devProfile ? <SettingRow body={copy.bridgeRouteBody} label={copy.bridgeRoute}>
          <Switch
            checked={snapshot.state.bridgeEnabled}
            disabled={busy || snapshot.state.codexSetupComplete !== true}
            onChange={(checked) => void setBridgeEnabled(checked)}
          />
        </SettingRow> : null}
        <SettingRow
          body={snapshot.state.browserInteractionMode === "manual"
            ? copy.manualInteractionBody : copy.automaticInteractionBody}
          label={copy.interactionMode}
        >
          <Switch
            checked={snapshot.state.browserInteractionMode === "manual"}
            disabled={busy}
            onChange={(enabled) => void setManualInteraction(enabled)}
          />
        </SettingRow>
        <SettingRow body={devProfile ? copy.devKeepRunningBody : copy.keepRunningOnCloseBody} label={copy.keepRunningOnClose}>
          <Switch
            checked={snapshot.state.keepRunningOnClose}
            onChange={(checked) => void api!.setPreference("keepRunningOnClose", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.showDuringTurnsBody} label={copy.showDuringTurns}>
          <Switch
            checked={snapshot.state.showBrowserDuringTurns}
            disabled={snapshot.state.browserInteractionMode === "manual"}
            onChange={(checked) => void api!.setPreference("showBrowserDuringTurns", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={snapshot.state.browserInteractionMode === "manual" ? copy.manualBiggerContextBody : copy.biggerContextBody} label={copy.biggerContext}>
          <Switch
            checked={biggerContextState.checked}
            disabled={biggerContextState.disabled}
            onChange={(enabled) => void setBiggerContext(enabled)}
          />
        </SettingRow>
        <SettingRow body={snapshot.state.browserInteractionMode === "manual"
          ? copy.manualSkillAttachmentsUnavailable : copy.skillAttachmentsBody} label={copy.skillAttachments}>
          <Switch
            checked={snapshot.state.experimentalSkillAttachments}
            disabled={busy || snapshot.state.browserInteractionMode === "manual" || !snapshot.state.coreSetupComplete}
            onChange={(enabled) => void setSkillAttachments(enabled)}
          />
        </SettingRow>
        <SettingRow body={copy.chooseLanguageHint} label={copy.language}>
          <LanguageMenu copy={copy} language={language} onChange={(next) => void updateLanguage(next)} />
        </SettingRow>
      </div>

      {!devProfile && snapshot.state.codexRestartRequired ? (
        <NoticeRow icon="alert" tone="warning">
          {copy.restartCodex}
        </NoticeRow>
      ) : null}

      <SectionHeading label={copy.diagnostics} spaced />
      <button className="diagnostic-row" disabled={busy} onClick={() => void runDoctor()} type="button">
        <Icon name="activity" />
        <span>
          <strong>{copy.runDoctor}</strong>
          <small>{doctor ? (doctor.ok ? copy.healthy : copy.needsAttention) : copy.status}</small>
        </span>
        <Icon name="chevron" />
      </button>
      {!devProfile ? <button className="diagnostic-row" disabled={busy} onClick={() => void cancelTurns()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.cancelTurns}</strong>
          <small>{turnsCancelled ? copy.turnsCancelled : copy.cancelTurnsBody}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {!devProfile ? <button className="diagnostic-row" disabled={busy} onClick={() => void uninstallIntegration()} type="button">
        <Icon name="close" />
        <span>
          <strong>{copy.uninstallIntegration}</strong>
          <small>{integrationRemoved ? copy.integrationRemoved : copy.uninstallIntegrationBody}</small>
        </span>
        <Icon name="chevron" />
      </button> : null}
      {doctor ? <DoctorSummary copy={copy} language={language} report={doctor} /> : null}

      <div className="about-row">
        <BrandMark small />
        <span>
          <strong>{copy.product}</strong>
          <small>
            {devProfile ? `${copy.devBadge} · ${snapshot.profilePaths.coreHome} · ` : ""}
            {platformLabel(snapshot.platform)} · v{snapshot.version}
          </small>
        </span>
      </div>
    </ContentSurface>
  );
}

function SettingRow({ body, children, label }: { body: string; children: ReactNode; label: string }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

function Switch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

function LanguageMenu({ copy, language, onChange }: { copy: Copy; language: Language; onChange: (language: Language) => void }) {
  const [open, setOpen] = useState(false);
  const options = (Object.keys(languages) as Language[]).map(value => ({ value, ...languages[value] }));
  const selected = options.find((option) => option.value === language) ?? options[0];

  return (
    <div
      className={`language-menu${open ? " is-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="language-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{selected.label}</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <>
          <button
            aria-label={`${copy.close}: ${copy.language}`}
            className="language-menu-scrim"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div aria-label={copy.language} className="language-menu-panel" role="listbox">
            {options.map((option) => (
              <button
                aria-selected={option.value === language}
                className={option.value === language ? "is-selected" : ""}
                key={option.value}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== language) onChange(option.value);
                }}
                role="option"
                type="button"
              >
                <span>{option.label}</span>
                {option.value === language ? <Icon name="check" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function platformLabel(value: string): string {
  return value === "darwin" ? "macOS" : value === "win32" ? "Windows" : value === "linux" ? "Linux" : value;
}

function formatSafetyResetTime(milliseconds: number, copy: Copy): string {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (totalMinutes < 60) return copy.accountSafetyMinutes.replace("{minutes}", String(totalMinutes));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourText = `${hours} ${copy.accountSafetyHoursUnit}`;
  return minutes === 0 ? hourText : `${hourText} ${copy.accountSafetyMinutes.replace("{minutes}", String(minutes))}`;
}
