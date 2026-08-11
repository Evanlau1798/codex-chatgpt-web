import { createHash } from "node:crypto";

const MAX_CLAUDE_STEERING_FINGERPRINTS = 32;

export function steeringFingerprint(instruction: string): string {
  return createHash("sha256").update(instruction).digest("hex");
}

export class ChatGptSteeringFeed {
  private readonly queued: string[] = [];
  private readonly provisionalClaude: string[] = [];
  private readonly completedClaude: string[] = [];

  push(instruction: string): void {
    this.queued.push(instruction);
  }

  peek(): { text: string; count: number } | undefined {
    return this.queued.length === 0 ? undefined : { text: this.queued.join("\n\n"), count: this.queued.length };
  }

  take(count = this.queued.length): string | undefined {
    if (this.queued.length === 0) return undefined;
    return this.queued.splice(0, count).join("\n\n");
  }

  acknowledgeClaude(count = this.queued.length): string | undefined {
    if (this.queued.length === 0) return undefined;
    const submitted = this.queued.splice(0, count);
    this.provisionalClaude.push(...submitted.map(steeringFingerprint));
    this.trim(this.provisionalClaude);
    return submitted.join("\n\n");
  }

  settleClaude(success: boolean): void {
    if (success) {
      this.completedClaude.push(...this.provisionalClaude);
      this.trim(this.completedClaude);
    }
    this.provisionalClaude.length = 0;
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
