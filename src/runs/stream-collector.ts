/** Accumulates streamed assistant text and thinking deltas for outbox updates. */
export class StreamCollector {
  private text = "";
  private thinking = "";

  appendText(delta: string): string {
    this.text += delta;
    return this.text;
  }

  appendThinking(delta: string): string {
    this.thinking += delta;
    return this.thinking;
  }

  getText(): string {
    return this.text;
  }

  getThinking(): string {
    return this.thinking;
  }
}
