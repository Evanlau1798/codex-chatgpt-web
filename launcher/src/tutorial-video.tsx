import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Copy } from "./i18n";
import { Icon } from "./icons";

export function TutorialVideo({ copy, label, src }: { copy: Copy; label: string; src: string }) {
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const inlineVideo = useRef<HTMLVideoElement>(null);
  const expandedVideo = useRef<HTMLVideoElement>(null);
  const expandedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const active = expanded ? expandedVideo.current : inlineVideo.current;
    if (expanded) inlineVideo.current?.pause();
    if (paused) active?.pause();
    else if (active) void active.play().catch(() => { if (!cancelled) setPaused(true); });
    return () => { cancelled = true; };
  }, [expanded, paused]);

  const playbackControl = {
    "aria-label": `${label}: ${paused ? copy.playGuideVideo : copy.pauseGuideVideo}`,
    role: "button",
    tabIndex: 0,
    onClick: () => setPaused(value => !value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLVideoElement>) => {
      if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault();
      setPaused(value => !value);
    },
  };

  const closeExpanded = () => {
    const currentTime = expandedVideo.current?.currentTime;
    if (inlineVideo.current && Number.isFinite(currentTime)) {
      inlineVideo.current.currentTime = currentTime ?? 0;
    }
    setExpanded(false);
  };

  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpanded();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  return (
    <>
      <div className="guide-media">
        <video {...playbackControl} autoPlay={!paused && !expanded} loop muted playsInline ref={inlineVideo} src={src} />
        <span aria-hidden="true" className={`guide-media-pause${paused ? " is-visible" : ""}`}>
          <Icon name="pause" />
        </span>
        <button
          aria-label={copy.expandGuideVideo}
          className="guide-media-expand"
          onClick={() => {
            expandedAt.current = inlineVideo.current?.currentTime ?? 0;
            setExpanded(true);
          }}
          type="button"
        >
          <Icon name="expand" />
        </button>
      </div>
      {expanded ? createPortal(
        <div
          aria-label={label}
          aria-modal="true"
          className="guide-media is-expanded"
          role="dialog"
        >
          <video
            {...playbackControl}
            autoPlay={!paused}
            loop
            muted
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = expandedAt.current;
            }}
            playsInline
            ref={expandedVideo}
            src={src}
          />
          <span aria-hidden="true" className={`guide-media-pause${paused ? " is-visible" : ""}`}>
            <Icon name="pause" />
          </span>
          <button
            aria-label={copy.closeGuideVideo}
            autoFocus
            className="guide-media-close"
            onClick={closeExpanded}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

