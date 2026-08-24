import { createHash } from "node:crypto";
import { completeArchiveChunks, type PendingContext, type TurnChannel } from "./turn-broker-state";
import { MAX_BROKER_LINE_CHARS, opaqueId } from "./turn-broker-protocol";

export class TurnContextStore {
  private readonly contexts = new Map<string, PendingContext>();

  register(text: string, ttlMs?: number, traceId = "unknown", turnToken?: string): string {
    if (!text) throw new Error("ChatGPT web context must not be empty");
    if (JSON.stringify({ context: text }).length + 256 > MAX_BROKER_LINE_CHARS) {
      throw new Error("ChatGPT web context exceeds the turn broker response size limit");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ChatGPT web context TTL must be a positive finite number");
    }
    const token = opaqueId("context");
    this.contexts.set(token, {
      text,
      traceId,
      ...(turnToken ? { turnToken } : {}),
      nextChunk: 0,
      complete: false,
      ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
    });
    return token;
  }

  revoke(token: string): void { this.contexts.delete(token); }
  clear(): void { this.contexts.clear(); }

  hasIncomplete(turnToken: string): boolean {
    return [...this.contexts.values()].some(context => context.turnToken === turnToken && !context.complete);
  }

  read(
    token: string,
    index: number | undefined,
    chunkChars: number | undefined,
    channels: Map<string, TurnChannel>,
  ): unknown {
    const direct = this.contexts.get(token);
    const inherited = direct ? [] : [...this.contexts.values()].filter(context => context.turnToken === token);
    if (inherited.length > 1) throw new Error("turn token has multiple active context archives");
    const context = direct ?? inherited[0];
    if (!context) throw new Error("context token is invalid, expired, or revoked");
    if (context.turnToken) channels.get(context.turnToken)?.onProgress?.();
    if (index === undefined && chunkChars === undefined) {
      context.complete = true;
      console.info(`[chatgpt-web] broker trace=${context.traceId} served context chars=${context.text.length} chunks=1`);
      return { context: context.text };
    }
    if (!Number.isInteger(index) || index! < 0 || !Number.isInteger(chunkChars) || chunkChars! < 1) {
      throw new Error("context archive chunk request is invalid");
    }
    if (context.chunkChars !== undefined && context.chunkChars !== chunkChars) {
      throw new Error("context archive chunk size changed during retrieval");
    }
    context.chunkChars = chunkChars;
    context.chunks ??= completeArchiveChunks(context.text, chunkChars!);
    const total = context.chunks.length;
    if (index! >= total) throw new Error("context archive chunk index is out of range");
    if (index! > context.nextChunk) throw new Error(`context archive chunk is out of order; expected ${context.nextChunk}`);
    const chunk = context.chunks[index!]!;
    const replayed = index! < context.nextChunk;
    if (!replayed) {
      context.nextChunk += 1;
      context.complete = context.nextChunk === total;
    }
    const sha256 = createHash("sha256").update(context.text).digest("hex");
    console.info(
      `[chatgpt-web] broker trace=${context.traceId} ${replayed ? "replayed" : "served"} context chunk=${index! + 1}/${total}`
      + ` chars=${chunk.length} complete=${context.complete}`,
    );
    return { context: chunk, index, total, sha256, nextIndex: index! + 1 === total ? null : index! + 1 };
  }

  prune(now: number): void {
    for (const [token, context] of this.contexts) {
      if (context.expiresAt !== undefined && context.expiresAt <= now) this.contexts.delete(token);
    }
  }
}
