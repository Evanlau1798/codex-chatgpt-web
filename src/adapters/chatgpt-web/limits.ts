import { createHash, randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright-core";
import { parseChatGptModelAnnouncement, readChatGptModelAnnouncements } from "../../chatgpt-session";

export type ChatGptLimitsPlan = "pro_100" | "pro_200" | "unsupported";
export type ChatGptUsageModel = "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

/** ChatGPT uses distinct account plan codes for Pro and Pro Light, independent of UI labels. */
export function supportsChatGptUsageTracking(account: { personal: boolean; planType: string }): boolean {
  return account.personal && ["pro", "prolite"].includes(account.planType);
}

/** Only stable account identity leaves the page; never export session credentials. */
export async function readChatGptUsageAccount(page: Page): Promise<{
  accountKey: string;
  planType: string;
  personal: boolean;
  needsAttention: boolean;
}> {
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new Error("Open ChatGPT and sign in before setting up Limits.");
  }
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      throw new Error("Limits could not verify the current ChatGPT account.");
    }
    const session = await response.json();
    if ((session?.error != null && session.error !== "") || (session?.expires != null
      && (typeof session.expires !== "string" || !Number.isFinite(Date.parse(session.expires))
        || Date.parse(session.expires) <= Date.now()))) {
      throw new Error("The ChatGPT session has expired. Sign in again before setting up Limits.");
    }
    // Deliberately copy only these fields from the session response.
    return {
      userId: session?.user?.id,
      accountId: session?.account?.id,
      planType: session?.account?.planType,
      structure: session?.account?.structure,
      needsAttention: session?.account?.isDelinquent === true,
    };
  });
  if ([identity.userId, identity.accountId, identity.planType, identity.structure]
    .some(value => typeof value !== "string" || !value || value.length > 256)) {
    throw new Error("Limits could not identify the current ChatGPT account. Sign in and retry.");
  }
  return {
    accountKey: createHash("sha256").update(`${identity.userId}\0${identity.accountId}`).digest("hex"),
    planType: identity.planType,
    personal: identity.structure === "personal",
    needsAttention: identity.needsAttention,
  };
}

/** Prepare one optional accounting record before Send; timestamp it only after acceptance. */
export async function prepareChatGptLimitsSubmission(page: Page, model: ChatGptUsageModel) {
  const id = randomUUID();
  let accountKey: string | undefined;
  try {
    const account = await readChatGptUsageAccount(page);
    if (supportsChatGptUsageTracking(account)) accountKey = account.accountKey;
  } catch {
    // A missing identity is reported as a tracking gap, never charged to the previous account.
  }
  return () => accountKey
    ? { receipt: { id, accountKey, model, at: Date.now() } }
    : { trackingError: "account-unavailable" as const };
}

/** The authenticated account tier is stable across renamed and translated billing headings. */
export async function detectChatGptLimitsPlan(page: Page): Promise<{ accountKey: string; plan: ChatGptLimitsPlan }> {
  const before = await readChatGptUsageAccount(page);
  if (!supportsChatGptUsageTracking(before)) return { accountKey: before.accountKey, plan: "unsupported" };
  if (before.needsAttention) {
    throw new Error("ChatGPT reports a subscription payment problem. Check your plan in ChatGPT settings before enabling Limits.");
  }
  const after = await readChatGptUsageAccount(page);
  if (after.accountKey !== before.accountKey || after.planType !== before.planType
    || !supportsChatGptUsageTracking(after) || after.needsAttention) {
    throw new Error("The ChatGPT account or subscription changed during Limits setup. Retry the check.");
  }
  return { accountKey: after.accountKey, plan: after.planType === "pro" ? "pro_200" : "pro_100" };
}

/** Read the selected family from the slider announcement and its active picker header. */
export async function readChatGptUsageModel(slider: Locator, isPro: boolean): Promise<ChatGptUsageModel> {
  if (!isPro) return "other";
  const announcements = await readChatGptModelAnnouncements(slider);
  return chatGptUsageModelFromAnnouncements(announcements);
}

export function chatGptUsageModelFromAnnouncements(announcements: readonly string[]): ChatGptUsageModel {
  const families = new Set<ChatGptUsageModel>();
  for (const text of announcements) {
    const state = parseChatGptModelAnnouncement(text);
    if (!state) continue;
    if (!/^Pro$/i.test(state.mode)) return "pro-unknown";
    if (state.version === "6" && (!state.name || state.name === "astra")) families.add("gpt-6-pro");
    else if (state.version === "5.6" && (!state.name || state.name === "sol")) families.add("gpt-5.6-pro");
    else return "pro-unknown";
  }
  return families.size === 1 ? [...families][0]! : "pro-unknown";
}
