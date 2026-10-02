// No lifetime deadline: only exceptional harness teardown has a bounded cleanup budget.
export async function withOwnedChild(child, action) {
  let settled = false;
  let actionError;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const onError = error => { settled = true; resolveCompletion({ code: 1, signal: null, error }); };
  const onClose = (code, signal) => { settled = true; resolveCompletion({ code, signal }); };
  child.once('error', onError);
  child.once('close', onClose);
  try { return await action(child, completion); }
  catch (error) { actionError = error; throw error; }
  finally {
    try {
    if (!settled) {
      child.kill('SIGTERM');
      let timer;
      try { await Promise.race([completion, new Promise(resolve => { timer = setTimeout(resolve, 750); })]); }
      finally { clearTimeout(timer); }
      if (!settled) {
        child.kill('SIGKILL');
        try { await Promise.race([completion, new Promise(resolve => { timer = setTimeout(resolve, 750); })]); }
        finally { clearTimeout(timer); }
      }
      if (!settled) throw new Error('Owned child failed to settle during exceptional harness cleanup');
    }
    } catch (cleanupError) {
      if (actionError !== undefined) throw new AggregateError([actionError, cleanupError], 'Harness action and owned child cleanup failed', { cause: actionError });
      throw cleanupError;
    } finally {
      if (settled) {
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      }
    }
  }
}
