import { createHash } from "node:crypto";

const MAX_CLAUDE_STEERING_FINGERPRINTS = 32;
type ClaudeSteeringSource = "user" | "coordinator";
interface QueuedSteering { text: string; claude: boolean; source: ClaudeSteeringSource; eventId: string; deliveryId?: string }
export interface CompletedClaudeSteering { fingerprint: string; text: string; deliveryId?: string }
export interface ClaudeSteeringDelivery { deliveryId: string; prompt: string }
export interface PendingSteeringMessage { deliveryId: string; sequence: number; source: ClaudeSteeringSource; content: string }

export function steeringFingerprint(instruction: string): string {
  return createHash("sha256").update(instruction).digest("hex");
}

export class ChatGptSteeringFeed {
  private readonly queued: QueuedSteering[] = [];
  private readonly seenClaudeDeliveryIds: string[] = [];
  private readonly provisionalClaude: CompletedClaudeSteering[] = [];
  private readonly completedClaude: CompletedClaudeSteering[] = [];
  private nextEventId = 1;

  push(instruction: string): void {
    this.queued.push({ text: instruction, claude: false, source: "user", eventId: `native-${this.nextEventId++}` });
  }

  pushClaude(instruction: string, deliveryId?: string, source: ClaudeSteeringSource = "user"): boolean {
    if (!deliveryId) {
      this.queued.push({ text: instruction, claude: true, source, eventId: `provisional-${this.nextEventId++}` });
      return true;
    }
    if (this.seenClaudeDeliveryIds.includes(deliveryId)) return false;
    const provisional = this.queued.find(entry => entry.claude && !entry.deliveryId && entry.text === instruction);
    if (provisional) provisional.deliveryId = deliveryId;
    else {
      const delivered = this.provisionalClaude
        .find(entry => !entry.deliveryId && entry.fingerprint === steeringFingerprint(instruction));
      if (delivered) delivered.deliveryId = deliveryId;
      else this.queued.push({ text: instruction, claude: true, source, eventId: deliveryId, deliveryId });
      if (delivered) {
        this.seenClaudeDeliveryIds.push(deliveryId);
        this.trim(this.seenClaudeDeliveryIds);
        return false;
      }
    }
    this.seenClaudeDeliveryIds.push(deliveryId);
    this.trim(this.seenClaudeDeliveryIds);
    if (provisional) return false;
    return true;
  }

  syncClaude(active: ClaudeSteeringDelivery[]): string[] {
    const activeIds = new Set(active.map(item => item.deliveryId));
    const accepted: string[] = [];
    for (const item of active) {
      if (this.pushClaude(item.prompt, item.deliveryId)) accepted.push(item.prompt);
    }
    const retained = this.queued.filter(item => !item.claude || (item.deliveryId !== undefined && activeIds.has(item.deliveryId)));
    this.queued.splice(0, this.queued.length, ...retained);
    return accepted;
  }

  peek(): { text: string; count: number; messages: PendingSteeringMessage[] } | undefined {
    return this.queued.length === 0 ? undefined : {
      text: this.queued.map(item => item.text).join("\n\n"),
      count: this.queued.length,
      messages: this.queued.map((item, index) => ({
        deliveryId: item.deliveryId ?? item.eventId,
        sequence: index + 1,
        source: item.source,
        content: item.text,
      })),
    };
  }

  peekClaude(): ReturnType<ChatGptSteeringFeed["peek"]> {
    return this.queued.length > 0 && this.queued.every(item => item.claude)
      ? this.peek()
      : undefined;
  }

  take(count = this.queued.length): string | undefined {
    if (this.queued.length === 0) return undefined;
    return this.queued.splice(0, count).map(item => item.text).join("\n\n");
  }

  acknowledgeClaude(count = this.queued.length): string | undefined {
    if (this.queued.length === 0) return undefined;
    const submitted = this.queued.splice(0, count);
    this.provisionalClaude.push(...submitted.map(item => ({
      fingerprint: steeringFingerprint(item.text),
      text: item.text,
      deliveryId: item.deliveryId,
    })));
    this.trim(this.provisionalClaude);
    return submitted.map(item => item.text).join("\n\n");
  }

  settleClaude(success: boolean): void {
    const submitted = this.provisionalClaude.splice(0);
    if (success) {
      this.completedClaude.push(...submitted);
      this.trim(this.completedClaude);
    }
  }

  claudeSuppressionCount(instruction: string): number {
    const fingerprint = steeringFingerprint(instruction);
    return this.provisionalClaude.filter(value => value.fingerprint === fingerprint).length
      + this.completedClaude.filter(value => value.fingerprint === fingerprint).length;
  }

  completedClaudeSteering(): CompletedClaudeSteering[] {
    return this.completedClaude.map(item => ({ ...item }));
  }

  inheritCompletedClaude(deliveries: CompletedClaudeSteering[]): void {
    this.completedClaude.push(...deliveries.map(delivery => ({ ...delivery })));
    this.trim(this.completedClaude);
  }

  private trim<T>(values: T[]): void {
    if (values.length > MAX_CLAUDE_STEERING_FINGERPRINTS) {
      values.splice(0, values.length - MAX_CLAUDE_STEERING_FINGERPRINTS);
    }
  }
}
