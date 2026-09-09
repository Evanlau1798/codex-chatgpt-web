const REVISION = /^[a-f0-9]{64}$/;

function assertSystemRevision(value) {
  if (value !== undefined && !REVISION.test(value)) throw new Error("systemRevision is invalid");
}

function selectSystemRevisionMode(tab, requested, reused) {
  assertSystemRevision(requested);
  if (!reused) return "full";
  return tab.systemRevision === requested ? "resume" : "refresh";
}

function beginSystemRevision(tab, requested, reused) {
  const mode = selectSystemRevisionMode(tab, requested, reused);
  tab.pendingSystemRevision = requested;
  return mode;
}

function matchesOwnedSystemRevision(tab, requested) {
  return (tab.status === "ready" ? tab.systemRevision : tab.pendingSystemRevision) === requested;
}

function shouldReplaceForUnavailableRefresh(tab, requested, available) {
  return available === false && selectSystemRevisionMode(tab, requested, true) === "refresh";
}

function commitSystemRevision(tab) {
  tab.systemRevision = tab.pendingSystemRevision;
  tab.pendingSystemRevision = undefined;
}

module.exports = {
  assertSystemRevision, beginSystemRevision, commitSystemRevision, matchesOwnedSystemRevision,
  selectSystemRevisionMode, shouldReplaceForUnavailableRefresh,
};
