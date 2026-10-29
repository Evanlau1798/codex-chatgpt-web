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
  if (!native) {
    const text = "innerText" in element && typeof element.innerText === "string"
      ? element.innerText : element.textContent ?? "";
    const values = text.match(/(?<![A-Za-z0-9_:-])codexsubmission:[a-f0-9]{32}(?![A-Za-z0-9_:-])/g) ?? [];
    // Non-authorizing IDs can be literal context; only this submission's ID proves ownership.
    return values.filter(value => value === identity).length === 1;
  }
  const visible = (node: Element): boolean => {
    const style = getComputedStyle(node);
    return !node.matches('[hidden], [inert], [aria-hidden="true"]')
      && style.display !== "none" && style.visibility !== "hidden"
      && style.visibility !== "collapse" && style.opacity !== "0";
  };
  let shown = element.isConnected;
  for (let parent = element.parentElement; parent && shown; parent = parent.parentElement) shown = visible(parent);
  // Preserve rendered line boundaries without joining across hidden text. Also retain
  // hidden source identities so an invisible duplicate or foreign token fails closed.
  const collect = (node: Node, rendered: boolean): { all: string; shown: string } => {
    if (node.nodeType === Node.TEXT_NODE) return { all: node.textContent ?? "", shown: rendered ? node.textContent ?? "" : "\0" };
    if (!(node instanceof Element)) return { all: "", shown: "" };
    const style = getComputedStyle(node);
    const isShown = rendered && visible(node);
    const boundary = node.localName === "br" || /^(?:block|flow-root|list-item|flex|grid|table)/.test(style.display) ? "\n" : "";
    const children = [...node.childNodes].map(child => collect(child, isShown));
    return { all: boundary + children.map(child => child.all).join("") + boundary,
      shown: isShown ? boundary + children.map(child => child.shown).join("") + boundary : "\0" };
  };
  const text = collect(element, shown);
  const tokens = (value: string) => value.match(/(?<![A-Za-z0-9_-])turn_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g) ?? [];
  const all = tokens(text.all), rendered = tokens(text.shown);
  return all.length === 1 && all[0] === identity && rendered.length === 1 && rendered[0] === identity;
}
