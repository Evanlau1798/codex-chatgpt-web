function settledFailure(results: PromiseSettledResult<void>[]): unknown {
  return results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
}

/** Keep one conversation barrier alive until every overlapping surface retirement has settled. */
export function trackConversationRetirement(
  retirements: Map<string, Promise<void>>,
  conversationKey: string,
  retirement: Promise<void>,
): Promise<void> {
  const previous = retirements.get(conversationKey);
  const tracked = previous
    ? Promise.allSettled([previous, retirement]).then(results => {
        const failure = settledFailure(results);
        if (failure !== undefined) throw failure;
      })
    : retirement;
  retirements.set(conversationKey, tracked);
  const clear = () => {
    if (retirements.get(conversationKey) === tracked) retirements.delete(conversationKey);
  };
  void tracked.then(clear, clear);
  return tracked;
}
