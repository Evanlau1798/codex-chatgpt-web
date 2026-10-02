import type { Locator } from "playwright-core";
import { ChatGptPromptOperation } from "./prompt-operation";
import { ChatGptPromptInsertionMetrics, type ChatGptPromptInsertionSnapshot } from "./prompt-insertion-metrics";
import { chatGptPromptInsertChunkEnd, planChatGptPromptInsertion, type ChatGptPromptInsertionOptions, type ChatGptPromptInsertionPlan } from "./prompt-insertion-plan";
import { pasteChatGptComposerLiteralText } from "./composer-literal-paste";

export async function insertChatGptPromptText(
  text: string,
  abortSignal: AbortSignal | undefined,
  actions: {
    composer(): Promise<Locator>;
    verify(expected: string): Promise<void>;
    reanchor(): Promise<void>;
    connectorSelected?: boolean;
    existingPrefix?: string;
    onProgress?(snapshot: ChatGptPromptInsertionSnapshot): void;
  },
  options?: ChatGptPromptInsertionOptions,
  operation?: ChatGptPromptOperation,
  selectedPlan?: ChatGptPromptInsertionPlan,
): Promise<void> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  const checked = async <T>(action: () => Promise<T>): Promise<T> => {
    op.check();
    const result = await action(); // Always settle mutations; never abandon an editor edit.
    op.check();
    return result;
  };
  op.check();
  const metrics = new ChatGptPromptInsertionMetrics(selectedPlan ?? planChatGptPromptInsertion(text, options), actions.onProgress, op.now);
  const verify = (expected: string, final = false) => metrics.run(final ? "final_verify" : "verify", async () => {
    await checked(() => actions.verify(expected));
    metrics.verified(expected.length);
  });
  try {
    if (!actions.connectorSelected) await checked(() => actions.verify(""));
    const prefix = actions.connectorSelected && actions.existingPrefix && text.startsWith(actions.existingPrefix)
      ? actions.existingPrefix : "";
    if (prefix.length > 1) {
      await verify(prefix);
      await metrics.run("reanchor", () => checked(actions.reanchor));
    }
    const insertionText = text.slice(prefix.length);
    const prefixUnits = text.length - insertionText.length;
    // Bound each public plain-paste transaction, never the logical message or a
    // Codex record. Avoid repeated editor reparses; no marker restoration.
    for (let offset = 0; offset < insertionText.length;) {
      const end = chatGptPromptInsertChunkEnd(insertionText, offset);
      await metrics.run("insert", async () => {
        const composer = await checked(() => actions.composer());
        metrics.chunk();
        await checked(() => pasteChatGptComposerLiteralText(composer, insertionText.slice(offset, end), abortSignal, metrics, op, actions.reanchor));
        metrics.inserted(end + prefixUnits);
      });
      // Every intermediate prefix must be exact before another mutation. The final
      // paste is checked once below, after yielding for editor settlement.
      if (end < insertionText.length) await verify(text.slice(0, end + prefixUnits));
      offset = end;
    }
    await op.poll(0);
    await verify(text, true);
    await metrics.run("reanchor", () => checked(actions.reanchor));
  } finally { metrics.finish(); }
}
