import { useState, type ReactNode } from "react";
import { biggerContextSwitchState } from "./context-mode";
import { Icon } from "./icons";
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
  BrowserInteractionMode,
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
} from "./types";

const api = window.codexWebLauncher;

export function SettingsSurface({
  configureInteractionMode,
  copy,
  devProfile,
  language,
  setError,
  snapshot,
  updateState,
}: {
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
      <SectionHeading label={copy.enhancedFeatureSettings} />
      <div className="settings-list">
        <SettingRow body={copy.enhancedWebSessionModeBody} label={copy.enhancedWebSessionMode}>
          <Switch
            checked={snapshot.state.useEnhancedWebSessionMode}
            disabled={busy || snapshot.state.coreSetupComplete !== true}
            onChange={(enabled) => void setUseEnhancedWebSessionMode(enabled)}
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

      <SectionHeading label={copy.general} />
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
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
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
  const options: Array<{ label: string; value: Language }> = [
    { label: copy.english, value: "en" },
    { label: copy.chinese, value: "zh-CN" },
    { label: copy.japanese, value: "ja" },
  ];
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
