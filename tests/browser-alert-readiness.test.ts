import { expect, test } from "bun:test";
import { throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert,
  throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";

const checks = [throwIfChatGptSessionFailureAlert, throwIfChatGptRateLimitDialog,
  throwIfChatGptTerminalErrorAlert];

function fixture(visible: boolean, wait: Promise<void>) {
  const reads: number[] = [], mutations: string[] = [];
  let index = 0;
  const locator = () => {
    const id = index++;
    const scope: any = { filter: () => scope, last: () => scope,
      isVisible: async () => { reads.push(id); await wait; return visible; },
      getByRole: () => scope, press: async () => { mutations.push("press"); } };
    return scope;
  };
  return { reads, mutations, page: { locator, getByText: locator, getByTestId: locator } as any };
}

test.each(checks)("independent alert reads start together: %p", async check => {
  let release!: () => void;
  const f = fixture(false, new Promise<void>(resolve => { release = resolve; }));
  const pending = check(f.page);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.reads).toEqual([0, 1]);
    expect(f.mutations).toEqual([]);
  } finally { release(); await pending; }
});

test.each([
  [throwIfChatGptSessionFailureAlert, "chatgpt_session_expired"],
  [throwIfChatGptRateLimitDialog, "chatgpt_account_safety_stop"],
  [throwIfChatGptTerminalErrorAlert, "upstream_server_error"],
] as const)("simultaneous alerts retain first error and never acknowledge: %p", async (check, code) => {
  const f = fixture(true, Promise.resolve());
  await expect(check(f.page)).rejects.toMatchObject({ code });
  expect(f.mutations).toEqual([]);
});

test("completed answer bypasses terminal error reads", async () => {
  const f = fixture(true, Promise.resolve());
  await throwIfChatGptTerminalErrorAlert(f.page, true);
  expect(f.reads).toEqual([]);
});

test.each([
  [throwIfChatGptSessionFailureAlert, "chatgpt_session_expired"],
  [throwIfChatGptRateLimitDialog, "chatgpt_account_safety_stop"],
  [throwIfChatGptTerminalErrorAlert, "upstream_server_error"],
] as const)("primary alert rejects while secondary read remains pending: %p", async (check, code) => {
  let release!: () => void;
  const secondary = new Promise<boolean>(resolve => { release = () => resolve(false); });
  const f = fixture(true, Promise.resolve());
  const locator = f.page.locator;
  let index = 0;
  const next = () => {
    const control = locator();
    if (index++ === 1) control.isVisible = () => secondary;
    return control;
  };
  f.page = { locator: next, getByText: next, getByTestId: next } as any;
  let outcome: any;
  const pending = check(f.page).catch(error => { outcome = error; });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(outcome?.code).toBe(code);
    expect(f.mutations).toEqual([]);
  } finally { release(); await pending; }
});
