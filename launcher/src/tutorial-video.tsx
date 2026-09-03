import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Copy } from "./i18n";
import { Icon } from "./icons";

export function TutorialVideo({ copy, label, src }: { copy: Copy; label: string; src: string }) {
  const [expanded, setExpanded] = useState(false);
  const inlineVideo = useRef<HTMLVideoElement>(null);
  const expandedVideo = useRef<HTMLVideoElement>(null);
  const expandedAt = useRef(0);

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
        <video aria-label={label} autoPlay loop muted playsInline ref={inlineVideo} src={src} />
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
            aria-label={label}
            autoPlay
            loop
            muted
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = expandedAt.current;
            }}
            playsInline
            ref={expandedVideo}
            src={src}
          />
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

