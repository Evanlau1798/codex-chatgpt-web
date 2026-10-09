/** The existing one-way ASCII-space-run/NBSP contract; no Unicode/LF normalization. */
export function chatGptPromptCodeUnitEquivalent(expected: string, observed: string, index: number): boolean {
  if (expected[index] === observed[index]) return true;
  return expected[index] === " " && observed[index] === "\u00a0"
    && (expected[index - 1] === " " || expected[index + 1] === " ");
}

export function chatGptPromptEquivalentPrefixLength(expected: string, observed: string): number {
  const length = Math.min(expected.length, observed.length);
  let index = 0;
  while (index < length && chatGptPromptCodeUnitEquivalent(expected, observed, index)) index += 1;
  return index;
}

export function chatGptPromptTextEquivalent(expected: string, observed: string): boolean {
  return expected.length === observed.length
    && chatGptPromptEquivalentPrefixLength(expected, observed) === expected.length;
}

/** Browser-serializable reader. Characterize this representation; never consult expected text. */
export function readChatGptPromptText(
  element: HTMLElement | SVGElement,
  options?: { preserveLeading?: boolean },
): string {
  const ignored = 'svg, script, style, [data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
  const blocks: string[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== 1) { blocks.push(child.textContent ?? ""); continue; }
    if ((child as Element).matches(ignored)) continue;
    const parts: string[] = [];
    // Read without cloning or repeatedly replacing siblings: each node is visited once.
    const pending: Node[] = [child];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.nodeType === 3 || node.nodeType === 4) { parts.push(node.textContent ?? ""); continue; }
      if (node.nodeType !== 1) continue;
      const part = node as Element;
      if (part.matches(ignored)) continue;
      if (part.tagName === "BR") {
        if (!part.classList.contains("ProseMirror-trailingBreak")) parts.push("\n");
        continue;
      }
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]!);
    }
    blocks.push(parts.join(""));
  }
  const text = blocks.join("\n");
  return options?.preserveLeading ? text : text.trimStart();
}

/** Content-free diagnostic only. It never changes the readback or acceptance decision. */
export function chatGptPromptMismatchDetails(expected: string, observed: string) {
  const commonPrefixChars = chatGptPromptEquivalentPrefixLength(expected, observed);
  let commonSuffixChars = 0;
  // Exact suffix comparison is deliberately conservative across shifted indices/NBSP runs.
  while (commonSuffixChars < Math.min(expected.length, observed.length) - commonPrefixChars
    && expected[expected.length - 1 - commonSuffixChars] === observed[observed.length - 1 - commonSuffixChars]) {
    commonSuffixChars += 1;
  }
  const deltaUnits = observed.length - expected.length;
  const kind = deltaUnits === 1 && observed[commonPrefixChars] === "\n"
      && commonPrefixChars + commonSuffixChars === expected.length
    ? "single_lf_insertion"
    : deltaUnits === -1 && expected[commonPrefixChars] === "\n"
      && commonPrefixChars + commonSuffixChars === observed.length
      ? "single_lf_deletion"
      : "other";
  return { expectedChars: expected.length, actualChars: observed.length,
    commonPrefixChars, commonSuffixChars, deltaUnits, kind };
}

/** Local-only diagnostic utility; public error messages must not contain reversible text windows. */
export function chatGptPromptCodePointWindow(value: string, offset: number): string {
  const result: string[] = [];
  for (let index = Math.max(0, offset); index < value.length && result.length < 6;) {
    const point = value.codePointAt(index)!;
    result.push(`U+${point.toString(16).toUpperCase().padStart(4, "0")}`);
    index += point > 0xffff ? 2 : 1;
  }
  return result.join(",");
}
