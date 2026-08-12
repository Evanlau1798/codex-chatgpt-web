export class ChatGptAnswerBuffer {
  private accepted = "";
  private candidate = "";

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

  value(): string {
    return this.accepted + this.candidate;
  }
}
