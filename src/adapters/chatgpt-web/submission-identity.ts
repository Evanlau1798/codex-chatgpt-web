import { randomUUID } from "node:crypto";
import type { CompiledChatGptWebPrompt } from "./prompt";

/** Identity only: read-only turns must never receive a work-tool capability. */
export function bindChatGptSubmissionIdentity<T extends CompiledChatGptWebPrompt>(prepared: T) {
  if (prepared.turnToken) return { prepared, identity: undefined };
  const identity = `codexsubmission:${randomUUID().replaceAll("-", "")}`;
  const suffix = `\n${identity}`;
  return {
    identity,
    prepared: {
      ...prepared,
      text: prepared.text + suffix,
      ...(prepared.multipart ? { multipart: { ...prepared.multipart, commit: prepared.multipart.commit + suffix } } : {}),
      ...(prepared.modelInputText !== undefined ? { modelInputText: prepared.modelInputText + suffix } : {}),
      ...(prepared.inlineChars !== undefined ? { inlineChars: prepared.inlineChars + suffix.length } : {}),
    },
  };
}

/** Browser-serializable; only a complete, unique identity can rebind a rendered message. */
export function chatGptSubmissionIdentityMatches(element: Element, identity: string): boolean {
  const native = /^turn_[A-Za-z0-9_-]{32}$/.test(identity);
  if (!native && !/^codexsubmission:[a-f0-9]{32}$/.test(identity)) return false;
  // Rich-text lines can be adjacent text nodes separated only by a rendered BR.
  const text = !native && "innerText" in element && typeof element.innerText === "string"
    ? element.innerText : element.textContent ?? "";
  const values = text.match(native
    ? /(?<![A-Za-z0-9_-])turn_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g
    : /(?<![A-Za-z0-9_:-])codexsubmission:[a-f0-9]{32}(?![A-Za-z0-9_:-])/g) ?? [];
  // Other non-authorizing IDs can be literal context; only this submission's ID proves ownership.
  return native ? values.length === 1 && values[0] === identity
    : values.filter(value => value === identity).length === 1;
}
