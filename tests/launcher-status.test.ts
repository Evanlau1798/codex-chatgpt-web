import { expect, test } from "bun:test";
import { describeTurnActivity } from "../launcher/src/turn-activity";
import type { BrowserTabState } from "../launcher/src/types";

test("waiting states expire without claiming a task failed or retaining an old approval", () => {
  const tab: BrowserTabState = { id: "one", traceId: "trace-one", title: "ChatGPT 1", status: "running",
    active: true, loading: false, closable: true,
    activity: { state: "tools", since: 1_000, updatedAt: 20_000, activeToolCalls: 1 } };
  expect(describeTurnActivity(tab, 25_000)).toEqual({ state: "tools", elapsedMs: 24_000, ageMs: 5_000 });
  expect(describeTurnActivity(tab, 50_001)).toEqual({ state: "stale", elapsedMs: null, ageMs: 30_001 });
  expect(tab.status).toBe("running");
  expect(describeTurnActivity(tab, 10_000)?.state).toBe("unknown");
  expect(describeTurnActivity({ ...tab, activity: undefined }, 25_000)?.state).toBe("unknown");
  expect(describeTurnActivity({ ...tab, authenticationRequired: true }, 25_000)?.state).toBe("sign-in");
  expect(describeTurnActivity({ ...tab, status: "ready" }, 25_000)).toBeNull();
  expect(describeTurnActivity({ ...tab, interactionMode: "manual" }, 25_000)).toBeNull();
});
