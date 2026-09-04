import type { Copy } from "./i18n";
import { Icon } from "./icons";
import type { BrowserInteractionMode } from "./types";

export function InteractionModePicker({
  className,
  copy,
  disabled,
  mode,
  onChange,
}: {
  className?: string;
  copy: Copy;
  disabled: boolean;
  mode: BrowserInteractionMode;
  onChange: (mode: BrowserInteractionMode) => void;
}) {
  return (
    <div
      aria-label={copy.interactionMode}
      className={`interaction-mode-picker${className ? ` ${className}` : ""}`}
      role="radiogroup"
    >
      {(["automatic", "manual"] as const).map((value) => (
        <button
          aria-checked={mode === value}
          className={mode === value ? "is-selected" : ""}
          disabled={disabled}
          key={value}
          onClick={() => onChange(value)}
          role="radio"
          type="button"
        >
          {mode === value ? <span className="interaction-mode-check"><Icon name="check" /></span> : null}
          <span>
            <strong>{value === "automatic" ? copy.automaticInteraction : copy.manualInteraction}</strong>
            <small>{value === "automatic" ? copy.automaticInteractionBody : copy.manualInteractionBody}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
