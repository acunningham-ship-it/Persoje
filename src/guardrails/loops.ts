/** Detects a model stuck in a loop: identical tool calls repeating within a window. */
export class LoopDetector {
  private recent: string[] = [];

  constructor(
    private windowSize = 6,
    private repeatThreshold = 3,
  ) {}

  /**
   * Record a call; returns true when this exact call (name + args) has now
   * appeared `repeatThreshold` times within the window — i.e. the model is stuck.
   */
  record(name: string, argsJson: string): boolean {
    const key = `${name}:${argsJson}`;
    this.recent.push(key);
    if (this.recent.length > this.windowSize) this.recent.shift();
    return this.recent.filter((k) => k === key).length >= this.repeatThreshold;
  }

  reset(): void {
    this.recent = [];
  }
}
