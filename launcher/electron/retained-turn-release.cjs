function releaseRetainedConversation(host, conversationKey) {
  const retained = [...host.turnTabs.values()].filter((tab) => (
    tab.status === "ready" && tab.conversationKey === conversationKey
  ));
  for (const tab of retained) host.removeTurnTab(tab, false);
  return retained.length;
}

module.exports = { releaseRetainedConversation };
