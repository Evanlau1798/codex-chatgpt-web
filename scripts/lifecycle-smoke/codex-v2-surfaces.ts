import { events } from "./common";

type LauncherEvents = ReturnType<typeof events>;

function traceIdForLauncherEvent(value: LauncherEvents[number]): string {
  const direct = String(value.detail?.traceId ?? "");
  if (direct) return direct;
  const line = String(value.detail?.line ?? "");
  return line.match(/browser turn ([A-Za-z0-9_-]+)/)?.[1]
    ?? line.match(/broker trace=([A-Za-z0-9_-]+)/)?.[1]
    ?? "";
}

export function ownedSurfaceEvents(
  launcher: LauncherEvents,
  seedTabs: Iterable<string>,
  seedTraces: Iterable<string>,
): LauncherEvents {
  const tabs = new Set(seedTabs);
  const traces = new Set(seedTraces);
  let changed: boolean;
  do {
    changed = false;
    for (const value of launcher) {
      const tabId = String(value.detail?.tabId ?? "");
      const traceId = traceIdForLauncherEvent(value);
      if (!(tabId && tabs.has(tabId)) && !(traceId && traces.has(traceId))) continue;
      if (tabId && !tabs.has(tabId)) { tabs.add(tabId); changed = true; }
      if (traceId && !traces.has(traceId)) { traces.add(traceId); changed = true; }
    }
  } while (changed);
  return launcher.filter(value => tabs.has(String(value.detail?.tabId ?? ""))
    || traces.has(traceIdForLauncherEvent(value)));
}

export function activeBrowserTraceIds(launcher: LauncherEvents): Set<string> {
  const active = new Set<string>();
  for (const value of launcher) {
    const traceId = traceIdForLauncherEvent(value);
    if (!traceId) continue;
    if (value.event === "browser.turn_started") active.add(traceId);
    if (value.event === "browser.turn_ended") active.delete(traceId);
  }
  return active;
}

export function excludeLauncherTraces(
  launcher: LauncherEvents,
  excludedTraces: ReadonlySet<string>,
): LauncherEvents {
  if (excludedTraces.size === 0) return launcher;
  return launcher.filter(value => {
    const traceId = traceIdForLauncherEvent(value);
    return !traceId || !excludedTraces.has(traceId);
  });
}

export function safeSurfaceRecoveryCount(
  launcher: LauncherEvents,
  excludedTraces: ReadonlySet<string> = new Set(),
): number | undefined {
  const ownedLauncher = excludeLauncherTraces(launcher, excludedTraces);
  const eligible = ownedLauncher.filter(value => /surface recovery eligible=true/.test(String(value.detail?.line ?? "")));
  if (eligible.length > 1) return undefined;
  for (const recovery of eligible) {
    const line = String(recovery.detail?.line ?? "");
    const traceId = line.match(/browser turn ([A-Za-z0-9_-]+)/)?.[1];
    if (!traceId
      || !/reason=eligible/.test(line)
      || !/finalChars=0/.test(line)
      || !/canonicalComplete=true/.test(line)
      || !/unresolvedSuperseded=0/.test(line)) return undefined;
    const created = ownedLauncher.find(value => value.event === "browser.tab_created"
      && value.detail?.traceId === traceId
      && Date.parse(value.at) >= Date.parse(recovery.at));
    const released = ownedLauncher.findLast(value => value.event === "browser.tab_released"
      && value.detail?.traceId === traceId
      && (value.detail?.status === "error" || value.detail?.status === "aborted")
      && Date.parse(value.at) <= Date.parse(created?.at ?? ""));
    const completed = ownedLauncher.find(value => value.event === "browser.tab_completed"
      && value.detail?.traceId === traceId
      && Date.parse(value.at) >= Date.parse(created?.at ?? ""));
    const rebuild = ownedLauncher.find(value => String(value.detail?.line ?? "")
      .includes(`browser turn ${traceId} rebuilding tool surface from canonical state`));
    if (!released || !created || !completed || !rebuild) return undefined;
  }
  return eligible.length;
}

export function latestSurfaceTabForTrace(launcher: LauncherEvents, traceId: string): string {
  return String(launcher.findLast(value => (
    (value.event === "browser.tab_created" || value.event === "browser.tab_reused")
    && value.detail?.traceId === traceId && value.detail?.tabId
  ))?.detail?.tabId ?? "");
}

export function classifyHierarchySurfaces(
  launcher: LauncherEvents,
  firstSpawnAt: number,
  expectFreshRoot: boolean | undefined,
  safeRecoveries: number | undefined,
  excludedTraces: ReadonlySet<string> = new Set(),
  plannedInterruptAt?: number,
) {
  const ownedLauncher = excludeLauncherTraces(launcher, excludedTraces);
  const surfaces = ownedLauncher.filter(value => value.event === "browser.tab_created" || value.event === "browser.tab_reused");
  const creates = surfaces.filter(value => value.event === "browser.tab_created");
  const rootSurfaces = surfaces.filter(value => Date.parse(value.at) < firstSpawnAt);
  const rootCreates = rootSurfaces.filter(value => value.event === "browser.tab_created");
  const rootTrace = String(rootSurfaces.findLast(value => value.detail?.traceId)?.detail?.traceId ?? "");
  const descendantCreates = creates.filter(value => Date.parse(value.at) >= firstSpawnAt
    && String(value.detail?.traceId ?? "") !== rootTrace);
  const descendantTabs = [...new Set(descendantCreates.flatMap(value => (
    value.detail?.tabId ? [String(value.detail.tabId)] : []
  )))];
  const interruptReplacements = plannedInterruptAt === undefined ? [] : descendantCreates.filter(created => {
    const createdAt = Date.parse(created.at);
    return createdAt >= plannedInterruptAt && ownedLauncher.some(released => released.event === "browser.tab_released"
      && released.detail?.status === "aborted" && released.detail?.tabId === descendantTabs[0]
      && released.detail?.traceId !== created.detail?.traceId
      && Date.parse(released.at) >= plannedInterruptAt && Date.parse(released.at) <= createdAt);
  });
  const plannedInterruptReplacements = plannedInterruptAt === undefined ? 0 : 1;
  const retainedRootReplacement = expectFreshRoot === false ? rootCreates.length : 0;
  const expectedCreates = (expectFreshRoot === false ? 2 : 3) + (safeRecoveries ?? 0)
    + retainedRootReplacement + plannedInterruptReplacements;
  const rootAcquisitionValid = expectFreshRoot === false
    ? rootSurfaces.some(value => value.event === "browser.tab_reused") && rootCreates.length <= 1
    : rootCreates.length >= 1;
  return {
    surfaces,
    creates,
    rootTrace,
    descendantTabs,
    expected: safeRecoveries !== undefined
      && rootAcquisitionValid
      && descendantTabs.length === 2 + plannedInterruptReplacements
      && interruptReplacements.length === plannedInterruptReplacements
      && creates.length === expectedCreates,
  };
}
