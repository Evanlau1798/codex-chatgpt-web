export interface LauncherBrowserConnectionStages<TBrowser, TResult> {
  ready(timeoutMs: number): Promise<void>;
  connect(timeoutMs: number): Promise<TBrowser>;
  select(browser: TBrowser, timeoutMs: number): Promise<TResult>;
  close(browser: TBrowser): Promise<unknown>;
}

export async function runLauncherBrowserConnection<TBrowser, TResult>(
  timeoutMs: number,
  stages: LauncherBrowserConnectionStages<TBrowser, TResult>,
  now: () => number = Date.now,
): Promise<TResult> {
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) throw new Error(`Launcher browser connection timed out after ${timeoutMs}ms`);
    return value;
  };
  await stages.ready(Math.min(remaining(), 5_000));
  const browser = await stages.connect(remaining());
  try {
    const budget = remaining();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      stages.select(browser, budget),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Launcher browser connection timed out after ${timeoutMs}ms`)),
          budget,
        );
        timer.unref?.();
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    remaining();
    return result;
  } catch (error) {
    await stages.close(browser).catch(() => {});
    throw error;
  }
}
