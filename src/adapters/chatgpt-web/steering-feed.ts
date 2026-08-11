import { createHash } from "node:crypto";

const MAX_CLAUDE_STEERING_FINGERPRINTS = 32;
interface QueuedSteering { text: string; claude: boolean; deliveryId?: string }
export interface ClaudeSteeringDelivery { deliveryId: string; prompt: string }

export function steeringFingerprint(instruction: string): string {
  return createHash("sha256").update(instruction).digest("hex");
}

export class ChatGptSteeringFeed {
  private readonly queued: QueuedSteering[] = [];
  private readonly seenClaudeDeliveryIds: string[] = [];
  private readonly provisionalClaude: string[] = [];
  private readonly completedClaude: string[] = [];

  push(instruction: string): void {
    this.queued.push({ text: instruction, claude: false });
  }

  pushClaude(instruction: string, deliveryId?: string): boolean {
    if (!deliveryId) {
      this.queued.push({ text: instruction, claude: true });
      return true;
    }
    if (this.seenClaudeDeliveryIds.includes(deliveryId)) return false;
    const provisional = this.queued.find(entry => entry.claude && !entry.deliveryId && entry.text === instruction);
    if (provisional) provisional.deliveryId = deliveryId;
    else this.queued.push({ text: instruction, claude: true, deliveryId });
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

  peek(): { text: string; count: number } | undefined {
    return this.queued.length === 0 ? undefined : { text: this.queued.map(item => item.text).join("\n\n"), count: this.queued.length };
  }

  take(count = this.queued.length): string | undefined {
    if (this.queued.length === 0) return undefined;
    return this.queued.splice(0, count).map(item => item.text).join("\n\n");
  }

  acknowledgeClaude(count = this.queued.length): string | undefined {
    if (this.queued.length === 0) return undefined;
    const submitted = this.queued.splice(0, count).map(item => item.text);
    this.provisionalClaude.push(...submitted.map(steeringFingerprint));
    this.trim(this.provisionalClaude);
    return submitted.join("\n\n");
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
    return this.provisionalClaude.filter(value => value === fingerprint).length
      + this.completedClaude.filter(value => value === fingerprint).length;
  }

  completedClaudeFingerprints(): string[] {
    return [...this.completedClaude];
  }

  inheritCompletedClaude(fingerprints: string[]): void {
    this.completedClaude.push(...fingerprints);
    this.trim(this.completedClaude);
  }

  private trim(fingerprints: string[]): void {
    if (fingerprints.length > MAX_CLAUDE_STEERING_FINGERPRINTS) {
      fingerprints.splice(0, fingerprints.length - MAX_CLAUDE_STEERING_FINGERPRINTS);
    }
  }
}
