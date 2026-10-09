import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { setChatGptThinkMode, throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert, throwIfChatGptTerminalErrorAlert, resolveChatGptToolConfirmation, isChatGptTraceControl, stripChatGptTraceControlSuffix } from "../src/adapters/chatgpt-web/browser-worker";

// Keep upstream test bodies unchanged; localized extensions live here.

function dialogPage(text: string, buttonText = "Got it", errorActionVisible = false): { page: Page; pressed: string[] } {
  const pressed: string[] = [];
  const createDialog = () => {
    let matches = true;
    let buttonMatches = true;
    const button = {
      last: () => button,
      isVisible: async () => matches && buttonMatches,
      press: async (key: string) => { pressed.push(key); },
    };
    const dialog = {
      filter: ({ hasText }: { hasText: string | RegExp }) => {
        matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
        return dialog;
      },
      last: () => dialog,
      isVisible: async () => matches,
      getByRole: (_role: string, options?: { name?: string | RegExp }) => {
        const name = options?.name;
        buttonMatches = name === undefined
          || (typeof name === "string" ? buttonText === name : name.test(buttonText));
        return button;
      },
    };
    return dialog;
  };
  return {
    page: {
      locator: () => createDialog(),
      getByText: (hasText: string | RegExp) => createDialog().filter({ hasText }),
      getByTestId: (testId: string) => {
        const action = {
          last: () => action,
          isVisible: async () => errorActionVisible && testId === "regenerate-thread-error-button",
        };
        return action;
      },
    } as unknown as Page,
    pressed,
  };
}

test.each([
  ["Too many requests. You're making requests too quickly.", "Got it"],
  ["Trop de requêtes. Vous envoyez des demandes trop rapidement.", "J’ai compris"],
  ["Trop de requêtes. Vous envoyez des demandes trop rapidement.", "J'ai compris"],
  ["요청을 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도해 주세요.", "알겠습니다"],
])("rate-limit dialog stops automatic resubmission: %s", async (message, button) => {
  const fixture = dialogPage(message, button);

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retireSession: true,
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("localized suspicious-activity protection dialogs return the same hard stop", async () => {
  for (const text of [
    "Nous détectons une activité suspecte. Veuillez réessayer plus tard.",
    "Activité inhabituelle détectée. Veuillez réessayer plus tard.",
    "偵測到可疑活動。請稍後再試。",
    "检测到可疑活动。请稍后再试。",
    "不審なアクティビティが検出されました。しばらくしてからもう一度お試しください。",
    "의심스러운 활동이 감지되었습니다. 나중에 다시 시도해 주세요.",
  ]) {
    const fixture = dialogPage(text);
    await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
      status: 403,
      code: "chatgpt_account_safety_stop",
      retryable: false,
      retireSession: true,
    });
    expect(fixture.pressed).toEqual([]);
  }
});

test.each([
    "Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
    "Une erreur s’est produite. Si ce problème persiste, veuillez contacter notre centre d’assistance à l’adresse help.openai.com.",
])("the known terminal ChatGPT error alert returns a structured retryable failure: %s", async text => {
  const fixture = dialogPage(text);

  await expect(throwIfChatGptTerminalErrorAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });
  expect(fixture.pressed).toEqual([]);
});

test.each([
    "Failed to load subscription: Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
    "Échec du chargement de l’abonnement : erreur. Si l’erreur persiste, rendez-vous sur help.openai.com.",
    "Échec du chargement de l'abonnement : erreur. Si l'erreur persiste, rendez-vous sur help.openai.com.",
])("a failed subscription fetch is retryable and does not falsely invalidate ChatGPT login: %s", async text => {
  const fixture = dialogPage(text);

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 503,
    errorType: "server_error",
    code: "chatgpt_subscription_unavailable",
    retryable: true,
  });
});

test.each([
  "Your session has expired. Please log in again to continue using the app. Log in",
  "Votre session a expiré. Veuillez vous connecter à nouveau pour continuer à utiliser l’application. Se connecter",
  "你的工作階段已過期 請重新登入以繼續使用應用程式。 登入",
  "您的会话已过期 请重新登录以继续使用该应用。 登录",
])("an expired ChatGPT session returns a non-retryable authentication failure: %s", async alertText => {
  const fixture = dialogPage(alertText);

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    errorType: "authentication_error",
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

function toolConfirmationPage(options: {
  disappearAfterReads?: number;
  surface?: "dialog" | "card";
  allowLabel?: string;
  denyLabel?: string;
  title?: string;
} = {}): {
  page: Page;
  pressed: string[];
} {
  let reads = 0;
  let visible = true;
  const pressed: string[] = [];
  const availableButtons = [options.allowLabel ?? "Allow once", options.denyLabel ?? "Deny"];
  let titleMatches = true;
  const button = (name: string | RegExp) => {
    const actualName = availableButtons.find(candidate => (
      typeof name === "string" ? candidate === name : name.test(candidate)
    ));
    return {
      filter: () => button(name),
      count: async () => actualName ? 1 : 0,
      last: () => button(name),
      waitFor: async () => {
        if (!actualName) throw new Error(`Approval button not found: ${String(name)}`);
      },
      click: async () => {
        if (!actualName) throw new Error(`Approval button not found: ${String(name)}`);
        pressed.push(`${actualName}:click`);
        visible = false;
      },
    };
  };
  const dialog = {
    filter: ({ hasText, has }: { hasText?: string | RegExp; has?: { name: string | RegExp } }) => {
      const title = options.title ?? "Allow ChatGPT to use Codex Native?";
      const name = has?.name ?? hasText;
      if (name !== undefined) titleMatches &&= typeof name === "string" ? title.includes(name) : name.test(title);
      return dialog;
    },
    last: () => dialog,
    first: () => dialog,
    count: async () => await dialog.isVisible() ? 1 : 0,
    isVisible: async () => {
      reads += 1;
      if (options.disappearAfterReads !== undefined && reads >= options.disappearAfterReads) visible = false;
      return visible && titleMatches;
    },
    getByRole: (_role: string, input: { name: string | RegExp }) => button(input.name),
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(visible).toBeFalse();
    },
  };
  const surfaceSelector = options.surface === "card"
    ? '[data-testid="tool-approval-card"]'
    : '[role="dialog"]';
  const hiddenDialog = {
    filter: () => hiddenDialog,
    last: () => hiddenDialog,
    isVisible: async () => false,
  };
  return {
    page: {
      getByText: (name: string | RegExp) => ({ name }),
      locator: (selector: string) => selector.includes(surfaceSelector)
        ? dialog
        : hiddenDialog,
    } as unknown as Page,
    pressed,
  };
}

test.each(["Autoriser", "Autoriser une fois"])("French one-shot tool approval accepts only %s", async allowLabel => {
  const fixture = toolConfirmationPage({ surface: "card", title: "Autoriser ChatGPT à utiliser Codex Native\u00a0?", allowLabel, denyLabel: "Refuser" });
  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual([`${allowLabel}:click`]);
});

test("French tool approval preserves manual handling, refusal and the exact connector identity", async () => {
  const options = { title: "Autoriser ChatGPT à utiliser Codex Native ?", allowLabel: "Autoriser une fois", denyLabel: "Refuser" };
  const manual = toolConfirmationPage({ ...options, disappearAfterReads: 3 });
  expect(await resolveChatGptToolConfirmation(manual.page, "Codex Native", false, undefined, 100)).toBeTrue();
  expect(manual.pressed).toEqual([]);
  const expired = toolConfirmationPage(options);
  expect(await resolveChatGptToolConfirmation(expired.page, "Codex Native", false, undefined, 1)).toBeTrue();
  expect(expired.pressed).toEqual(["Refuser:click"]);
  for (const appName of ["Codex Other", "Codex Native.*", "Codex (Native)"]) {
    const unrelated = toolConfirmationPage(options);
    expect(await resolveChatGptToolConfirmation(unrelated.page, appName, true)).toBeFalse();
    expect(unrelated.pressed).toEqual([]);
  }
  const literal = toolConfirmationPage({ ...options, title: "Autoriser ChatGPT à utiliser Codex (Native) ?" });
  expect(await resolveChatGptToolConfirmation(literal.page, "Codex (Native)", true)).toBeTrue();
});

test.each(["Always allow", "Toujours autoriser"])("one-shot approval never selects persistent permission %s", async allowLabel => {
  const fixture = toolConfirmationPage({ title: "Autoriser ChatGPT à utiliser Codex Native ?", allowLabel });
  await expect(resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).rejects.toThrow("Approval button not found");
  expect(fixture.pressed).toEqual([]);
});

test("French status controls do not leak into the answer or swallow ordinary prose", () => {
  for (const text of ["Répondre maintenant", "Réflexion", "Réflexion en cours", "Réflexion…", "Réflexion en cours..."]) {
    expect(isChatGptTraceControl({ kind: "status", text })).toBeTrue();
    expect(isChatGptTraceControl({ kind: "answer", text })).toBeFalse();
  }
  expect(stripChatGptTraceControlSuffix({ kind: "status", text: "Vérification des fichiers Répondre maintenant" }).text).toBe("Vérification des fichiers");
  expect(stripChatGptTraceControlSuffix({ kind: "answer", text: "Répondre maintenant" }).text).toBe("Répondre maintenant");
  expect(isChatGptTraceControl({ kind: "status", text: "Réflexion sur les tests" })).toBeFalse();
});

function fixture(label = "Think") {
  const state = { pressed: false, controlPresent: true, highlighted: true, popupCount: 1,
    optionCount: 1, draft: "", connectors: [] as string[], loseConnector: false,
    commands: [] as string[], enters: 0, clicks: 0, pollsBeforeToggle: 0, pendingToggle: false };
  const control = { getAttribute: async () => {
    if (state.pendingToggle && state.pollsBeforeToggle-- <= 0) {
      state.pressed = !state.pressed;
      state.pendingToggle = false;
    }
    return state.pressed ? "true" : "false";
  }, click: async () => { state.pressed = !state.pressed; state.clicks += 1; } };
  const controls = { count: async () => state.controlPresent ? 1 : 0, first: () => control };
  const row = { getAttribute: async () => state.highlighted ? "" : null,
    waitFor: async () => { if (!state.optionCount) throw new Error("Think command is unavailable"); } };
  const rows = { filter: () => rows, first: () => row, count: async () => state.optionCount };
  const popup = { filter: () => popup, locator: () => rows, count: async () => state.popupCount };
  const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
  const page = { locator: (selector: string) => selector === '[role="dialog"]' ? absentDialog : popup,
    keyboard: { press: async () => {} } };
  const composer = {
    filter: () => composer, first: () => composer, locator: () => composerForm, page: () => page,
    evaluate: async () => ({ text: state.draft.trim(), connectors: [...state.connectors] }),
    focus: async () => {},
    fill: async (text: string) => { state.draft = text; state.connectors = []; },
    pressSequentially: async (text: string) => { state.commands.push(text); state.draft += text; },
    press: async (key: string) => {
      if (key === "ArrowDown") state.highlighted = true;
      if (key === "Enter") {
        if (state.draft !== "/think" || !state.highlighted) throw new Error("Unexpected composer submission");
        state.enters += 1;
        if (state.pollsBeforeToggle > 0) state.pendingToggle = true;
        else state.pressed = !state.pressed;
        state.controlPresent = true;
        state.draft = "";
        if (state.loseConnector) state.connectors = [];
      }
    },
  };
  const composerForm = { getByRole: (_role: string, options: { name: string | RegExp }) => ({ filter: () => ({ ...controls,
    count: async () => (typeof options.name === "string" ? options.name === label : options.name.test(label)) ? controls.count() : 0,
  }) }), locator: () => composer, page: () => page };
  return { state, composer, composerForm, page };
}

test.each(["Think", "Analyser"])("%s slash toggles only when needed and preserves selected connectors", async label => {
  const ui = fixture(label);
  ui.state.controlPresent = false;
  ui.state.connectors = ["Codex Native2"];
  await setChatGptThinkMode(ui.composer as never, true);
  expect(ui.state.pressed).toBeTrue();
  expect(ui.state.commands).toEqual(["/think"]);
  expect(ui.state.connectors).toEqual(["Codex Native2"]);
  await setChatGptThinkMode(ui.composer as never, true);
  await setChatGptThinkMode(ui.composer as never, false);
  expect(ui.state.pressed).toBeFalse();
  expect(ui.state.commands).toEqual(["/think"]);
  expect(ui.state.enters).toBe(1);
  expect(ui.state.clicks).toBe(1);
});

test.each(["Think", "Analyser"])("%s uses its visible semantic control without inserting a slash command", async label => {
  const ui = fixture(label);
  ui.state.connectors = ["Codex Native2"];
  await setChatGptThinkMode(ui.composer as never, true);
  expect(ui.state.pressed).toBeTrue();
  await setChatGptThinkMode(ui.composer as never, true);
  await setChatGptThinkMode(ui.composer as never, false);
  expect(ui.state.pressed).toBeFalse();
  expect(ui.state.commands).toEqual([]);
  expect(ui.state.enters).toBe(0);
  expect(ui.state.clicks).toBe(2);
  expect(ui.state.connectors).toEqual(["Codex Native2"]);
});
