export class ChatGptAnswerBuffer {
  private accepted = "";
  private candidate = "";
  private delivered = 0;

  append(delta: string): void {
    this.candidate += delta;
  }

  continueAfterError(): void {
    this.accepted += this.candidate;
    this.candidate = "";
  }

  retryReplacement(): void {
    this.candidate = "";
  }

  takeDeliverable(includeCandidate: boolean): string {
    const value = this.accepted + (includeCandidate ? this.candidate : "");
    const delta = value.slice(this.delivered);
    this.delivered = value.length;
    return delta;
  }

  value(): string {
    return this.accepted + this.candidate;
  }

  deliveredChars(): number {
    return this.delivered;
  }
}
