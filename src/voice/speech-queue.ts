export interface Spoken { line: string; priority: 1 | 2 }

/**
 * Which lines wait their turn. Replies to orders (priority 2) queue up and play in order; the queue is short, so
 * speech cannot fall far behind the game: when it is full the oldest waiting line is dropped. Game events
 * (priority 1) are only worth saying right away, so they are skipped whenever anything is playing or waiting.
 */
export class SpeechQueue {
  private items: Spoken[] = [];
  constructor(private max = 3) {}

  get length() { return this.items.length; }

  /** Returns whether the line was accepted. `busy` says whether something is playing right now. */
  push(line: string, priority: 1 | 2, busy: boolean): boolean {
    if (priority === 1 && (busy || this.items.length)) return false;
    if (this.items[this.items.length - 1]?.line === line) return false;
    this.items.push({ line, priority });
    while (this.items.length > this.max) this.items.shift();
    return true;
  }

  next(): Spoken | undefined {
    return this.items.shift();
  }

  clear() {
    this.items = [];
  }
}
