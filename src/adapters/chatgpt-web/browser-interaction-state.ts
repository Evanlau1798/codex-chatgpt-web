/** Runs in the page. Record actionability without labels, identifiers or conversation text. */
export async function chatGptInteractionState({ selector, sampleFrames }: { selector: string; sampleFrames: boolean }) {
  const controls = [...document.querySelectorAll(selector)].slice(-10).map(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    let hiddenAncestor = false;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (parent.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden"
        || style.opacity === "0") { hiddenAncestor = true; break; }
    }
    return {
      disabled: element.matches(":disabled"),
      ariaDisabled: element.getAttribute("aria-disabled") === "true",
      pointerEventsNone: getComputedStyle(element).pointerEvents === "none",
      hiddenAncestor,
      centerHit: hit !== null && (hit === element || element.contains(hit)),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  const frames = sampleFrames ? await new Promise<{ count: number; elapsedMs: number }>(resolve => {
    const start = performance.now();
    let count = 0;
    let frameId = requestAnimationFrame(tick);
    function tick() { count++; frameId = requestAnimationFrame(tick); }
    setTimeout(() => {
      cancelAnimationFrame(frameId);
      resolve({ count, elapsedMs: Math.round(performance.now() - start) });
    }, 500);
  }) : undefined;
  return { documentHidden: document.hidden, documentFocused: document.hasFocus(), controls, ...(frames ? { frames } : {}) };
}
