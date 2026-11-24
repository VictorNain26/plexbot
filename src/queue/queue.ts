import type { LoopMode } from '../types.js';

/** Past entries kept for « précédent »; older ones are dropped. */
export const HISTORY_LIMIT = 50;

export interface QueueSnapshot<T> {
  readonly items: readonly T[];
  readonly index: number;
  readonly loop: LoopMode;
}

/**
 * The play queue of one guild, without any I/O.
 *
 * `items[index]` is the current entry; entries before it are the history, entries after it are
 * upcoming. `index === items.length` means the queue ran out: nothing is current.
 * Positions given to the editing methods are 1-based among the upcoming entries, as shown to users.
 */
export class Queue<T> {
  #items: T[];
  #index: number;
  #loop: LoopMode;

  constructor(snapshot?: QueueSnapshot<T>) {
    this.#items = [...(snapshot?.items ?? [])];
    this.#index = Math.min(Math.max(snapshot?.index ?? 0, 0), this.#items.length);
    this.#loop = snapshot?.loop ?? 'off';
  }

  get current(): T | undefined {
    return this.#items[this.#index];
  }

  get upcoming(): readonly T[] {
    return this.#items.slice(this.#index + 1);
  }

  get history(): readonly T[] {
    return this.#items.slice(0, Math.min(this.#index, this.#items.length));
  }

  get loop(): LoopMode {
    return this.#loop;
  }

  set loop(mode: LoopMode) {
    this.#loop = mode;
  }

  /** Appends entries, or inserts them right after the current one when `next` is set. */
  add(entries: readonly T[], options: { next?: boolean } = {}): void {
    if (this.current === undefined) {
      this.#items.splice(this.#index, 0, ...entries);
      return;
    }
    const at = options.next === true ? this.#index + 1 : this.#items.length;
    this.#items.splice(at, 0, ...entries);
  }

  /**
   * Moves to the entry that plays next. A track that ends by itself repeats under loop `track`;
   * a skip always moves on. Under loop `queue`, the end wraps to the first entry still kept.
   */
  advance(reason: 'ended' | 'skip'): T | undefined {
    if (this.#items.length === 0) return undefined;
    if (reason === 'ended' && this.#loop === 'track' && this.current !== undefined) return this.current;
    if (this.#index + 1 < this.#items.length) {
      this.#index += 1;
    } else if (this.#loop === 'queue') {
      this.#index = 0;
    } else {
      this.#index = this.#items.length;
    }
    this.#trimHistory();
    return this.current;
  }

  /** Steps back one entry; at the start, stays on the first. */
  previous(): T | undefined {
    if (this.#items.length === 0) return undefined;
    this.#index = Math.max(Math.min(this.#index, this.#items.length) - 1, 0);
    return this.current;
  }

  /** Skips straight to the upcoming entry at `position`, dropping none of the others. */
  skipTo(position: number): T | undefined {
    this.#assertPosition(position);
    this.#index += position;
    return this.current;
  }

  /** Shuffles the upcoming entries with a Fisher–Yates pass; `random` returns a number in [0, 1). */
  shuffle(random: () => number = Math.random): void {
    const start = this.#index + 1;
    for (let i = this.#items.length - 1; i > start; i--) {
      const j = start + Math.floor(random() * (i - start + 1));
      const a = this.#items[i] as T;
      this.#items[i] = this.#items[j] as T;
      this.#items[j] = a;
    }
  }

  remove(position: number): T {
    this.#assertPosition(position);
    const [removed] = this.#items.splice(this.#index + position, 1);
    return removed as T;
  }

  move(from: number, to: number): void {
    this.#assertPosition(from);
    this.#assertPosition(to);
    const [entry] = this.#items.splice(this.#index + from, 1);
    this.#items.splice(this.#index + to, 0, entry as T);
  }

  /** Drops every upcoming entry; the current one keeps playing. */
  clearUpcoming(): void {
    this.#items.splice(this.#index + 1);
  }

  /** Takes over a saved state, as the constructor would. */
  replace(snapshot: QueueSnapshot<T>): void {
    const q = new Queue(snapshot);
    this.#items = [...q.#items];
    this.#index = q.#index;
    this.#loop = q.#loop;
  }

  /** Empties the queue entirely. */
  reset(): void {
    this.#items = [];
    this.#index = 0;
  }

  snapshot(): QueueSnapshot<T> {
    return { items: [...this.#items], index: this.#index, loop: this.#loop };
  }

  #assertPosition(position: number): void {
    if (!Number.isInteger(position) || position < 1 || position > this.upcoming.length) {
      throw new RangeError(`position ${position} is outside 1..${this.upcoming.length}`);
    }
  }

  #trimHistory(): void {
    const excess = this.#index - HISTORY_LIMIT;
    if (excess > 0 && this.#loop !== 'queue') {
      this.#items.splice(0, excess);
      this.#index -= excess;
    }
  }
}

/** A shuffled copy (Fisher–Yates); `random` returns a number in [0, 1). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
