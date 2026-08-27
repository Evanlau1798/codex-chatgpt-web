import { assert } from "./common";

type LifecycleEvent = { event?: string; detail?: Record<string, unknown> };

export function manualCompactPreservedRetainedRoot(
  priorRootEvents: LifecycleEvent[],
  compactRootEvents: LifecycleEvent[],
  rootTab: string,
): boolean {
  const retainedBeforeCompact = priorRootEvents.some(value => (
    value.event === "browser.tab_retained" && value.detail?.tabId === rootTab
  ));
  const reusedDuringCompact = compactRootEvents.some(value => (
    value.event === "browser.tab_reused" && value.detail?.tabId === rootTab
  ));
  const invalidatedDuringCompact = compactRootEvents.some(value => (
    ((value.event === "browser.tab_released" || value.event === "browser.tab_closed")
      && value.detail?.tabId === rootTab)
    || (value.event === "browser.tab_created" && value.detail?.tabId !== rootTab)
  ));
  return (retainedBeforeCompact || reusedDuringCompact) && !invalidatedDuringCompact;
}

export function manualCompactContinuityPassed(
  retained: boolean,
  replacementCreated: boolean,
  recoveryProved: boolean,
): boolean {
  return retained || (replacementCreated && recoveryProved);
}

export function selfTestManualCompactRetainedRoot(): void {
  assert(manualCompactPreservedRetainedRoot(
    [{ event: "browser.tab_retained", detail: { tabId: "root-tab" } }],
    [],
    "root-tab",
  ), "Claude local /compact must accept an already-retained root when it emits no browser lifecycle events");
  assert(!manualCompactPreservedRetainedRoot(
    [{ event: "browser.tab_retained", detail: { tabId: "root-tab" } }],
    [{ event: "browser.tab_released", detail: { tabId: "root-tab" } }],
    "root-tab",
  ), "Claude local /compact must reject a root released during compaction");
  assert(!manualCompactPreservedRetainedRoot(
    [{ event: "browser.tab_retained", detail: { tabId: "root-tab" } }],
    [{ event: "browser.tab_created", detail: { tabId: "replacement-tab" } }],
    "root-tab",
  ), "Claude local /compact must reject an unproved replacement surface");
  assert(manualCompactContinuityPassed(false, true, true),
    "Claude local /compact must accept a replacement only when recovery is proved");
  assert(!manualCompactContinuityPassed(false, true, false),
    "Claude local /compact must reject an unproved replacement");
}
