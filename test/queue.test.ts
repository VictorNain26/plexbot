import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, Queue } from '../src/queue/queue.js';

const filled = (...items: string[]) => {
  const q = new Queue<string>();
  q.add(items);
  return q;
};

describe('Queue', () => {
  it('plays entries in order, then runs out', () => {
    const q = filled('a', 'b');
    expect(q.current).toBe('a');
    expect(q.advance('ended')).toBe('b');
    expect(q.advance('ended')).toBeUndefined();
    expect(q.current).toBeUndefined();
  });

  it('starts playing what is added after it ran out', () => {
    const q = filled('a');
    q.advance('ended');
    q.add(['b']);
    expect(q.current).toBe('b');
    expect(q.history).toEqual(['a']);
  });

  it('inserts right after the current entry with next', () => {
    const q = filled('a', 'b', 'c');
    q.add(['x', 'y'], { next: true });
    expect(q.upcoming).toEqual(['x', 'y', 'b', 'c']);
  });

  it('repeats a track that ends under loop track, but a skip moves on', () => {
    const q = filled('a', 'b');
    q.loop = 'track';
    expect(q.advance('ended')).toBe('a');
    expect(q.advance('skip')).toBe('b');
  });

  it('wraps around under loop queue', () => {
    const q = filled('a', 'b');
    q.loop = 'queue';
    q.advance('ended');
    expect(q.advance('ended')).toBe('a');
  });

  it('steps back with previous and stays on the first entry', () => {
    const q = filled('a', 'b');
    q.advance('skip');
    expect(q.previous()).toBe('a');
    expect(q.previous()).toBe('a');
  });

  it('goes back to the last entry from the end of the queue', () => {
    const q = filled('a', 'b');
    q.advance('ended');
    q.advance('ended');
    expect(q.previous()).toBe('b');
  });

  it('skips to an upcoming position', () => {
    const q = filled('a', 'b', 'c', 'd');
    expect(q.skipTo(2)).toBe('c');
    expect(q.history).toEqual(['a', 'b']);
  });

  it('removes and moves by 1-based upcoming position', () => {
    const q = filled('now', 'a', 'b', 'c');
    expect(q.remove(2)).toBe('b');
    q.move(2, 1);
    expect(q.upcoming).toEqual(['c', 'a']);
  });

  it('rejects positions outside the upcoming entries', () => {
    const q = filled('now', 'a');
    expect(() => q.remove(0)).toThrow(RangeError);
    expect(() => q.remove(2)).toThrow(RangeError);
    expect(() => q.skipTo(1.5)).toThrow(RangeError);
    expect(() => {
      q.move(1, 3);
    }).toThrow(RangeError);
  });

  it('clears the upcoming entries and keeps the current one', () => {
    const q = filled('a', 'b', 'c');
    q.clearUpcoming();
    expect(q.current).toBe('a');
    expect(q.upcoming).toEqual([]);
  });

  it('keeps at most HISTORY_LIMIT past entries', () => {
    const q = filled(...Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => `t${i}`));
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) q.advance('ended');
    expect(q.history).toHaveLength(HISTORY_LIMIT);
    expect(q.current).toBe(`t${HISTORY_LIMIT + 5}`);
  });

  it('restores from its snapshot', () => {
    const q = filled('a', 'b', 'c');
    q.advance('skip');
    q.loop = 'queue';
    const copy = new Queue(q.snapshot());
    expect(copy.current).toBe('b');
    expect(copy.loop).toBe('queue');
    expect(copy.upcoming).toEqual(['c']);
  });

  it('clamps a snapshot index that points past its items', () => {
    expect(new Queue({ items: ['a'], index: 9, loop: 'off' }).current).toBeUndefined();
    expect(new Queue({ items: ['a'], index: -3, loop: 'off' }).current).toBe('a');
  });

  it('empties with reset', () => {
    const q = filled('a', 'b');
    q.reset();
    expect(q.current).toBeUndefined();
    expect(q.advance('skip')).toBeUndefined();
    expect(q.previous()).toBeUndefined();
  });
});

describe('Queue properties', () => {
  const items = fc.uniqueArray(fc.string(), { minLength: 0, maxLength: 30 });

  it('shuffle keeps the current entry, the history and the same upcoming entries', () => {
    fc.assert(
      fc.property(
        items,
        fc.nat({ max: 29 }),
        fc.infiniteStream(fc.double({ min: 0, max: 0.999999, noNaN: true })),
        (xs, skips, rs) => {
          const q = filled(...xs);
          for (let i = 0; i < Math.min(skips, xs.length); i++) q.advance('skip');
          const before = q.snapshot();
          const it = rs[Symbol.iterator]();
          q.shuffle(() => it.next().value as number);
          expect(q.current).toBe(before.items[before.index]);
          expect(q.history).toEqual(before.items.slice(0, before.index));
          expect([...q.upcoming].sort()).toEqual(before.items.slice(before.index + 1).sort());
        },
      ),
    );
  });

  it('move then the inverse move gives the queue back', () => {
    fc.assert(
      fc.property(
        items.filter((xs) => xs.length >= 2),
        fc.nat(),
        fc.nat(),
        (xs, a, b) => {
          const q = filled(...xs);
          const n = q.upcoming.length;
          if (n === 0) return;
          const from = (a % n) + 1;
          const to = (b % n) + 1;
          const before = q.upcoming;
          q.move(from, to);
          q.move(to, from);
          expect(q.upcoming).toEqual(before);
        },
      ),
    );
  });

  it('advancing never loses an entry while loop is off and the history is short', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string(), { maxLength: HISTORY_LIMIT }),
        fc.nat({ max: 60 }),
        (xs, steps) => {
          const q = filled(...xs);
          for (let i = 0; i < steps; i++) q.advance('ended');
          const all = [...q.history, ...(q.current === undefined ? [] : [q.current]), ...q.upcoming];
          expect(all).toEqual(xs);
        },
      ),
    );
  });

  it('under loop queue, the queue always has a current entry once filled', () => {
    fc.assert(
      fc.property(
        items.filter((xs) => xs.length > 0),
        fc.nat({ max: 100 }),
        (xs, steps) => {
          const q = filled(...xs);
          q.loop = 'queue';
          for (let i = 0; i < steps; i++) q.advance(i % 2 === 0 ? 'ended' : 'skip');
          expect(q.current).toBeDefined();
        },
      ),
    );
  });
});
