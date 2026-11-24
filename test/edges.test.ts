import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeRef, matches, toChoices, toTrack, trackGainDb, truncate } from '../src/plex/mapping.js';
import type { Metadata } from '../src/plex/schemas.js';
import { HISTORY_LIMIT, Queue, shuffled } from '../src/queue/queue.js';

const track = (over: Partial<Metadata> = {}): Metadata => ({
  ratingKey: '1',
  type: 'track',
  title: 'T',
  grandparentTitle: 'A',
  parentTitle: 'B',
  librarySectionTitle: 'Musique',
  librarySectionID: 8,
  ...over,
});

describe('Queue edges', () => {
  it('starts with loop off and nothing current', () => {
    const q = new Queue<string>();
    expect(q.loop).toBe('off');
    expect(q.current).toBeUndefined();
    expect(q.advance('ended')).toBeUndefined();
    expect(q.upcoming).toEqual([]);
  });

  it('adds at the front of what is left when nothing plays, even with next', () => {
    const q = new Queue<string>();
    q.add(['a', 'b'], { next: true });
    expect(q.current).toBe('a');
    expect(q.upcoming).toEqual(['b']);
  });

  it('shuffles the upcoming entries with the given random source, deterministically', () => {
    const q = new Queue<string>();
    q.add(['now', 'a', 'b', 'c']);
    q.shuffle(() => 0);
    // i=3: j=1 → [now,c,b,a]; i=2: j=1 → [now,b,c,a]
    expect(q.upcoming).toEqual(['b', 'c', 'a']);
    q.shuffle(() => 0.999);
    expect(q.upcoming).toEqual(['b', 'c', 'a']);
  });

  it('removes and skips to the exact entries', () => {
    const q = new Queue<string>();
    q.add(['now', 'a', 'b', 'c']);
    expect(q.remove(1)).toBe('a');
    expect(q.skipTo(2)).toBe('c');
    expect(q.history).toEqual(['now', 'b']);
  });

  it('moves an entry forward and backward', () => {
    const q = new Queue<string>();
    q.add(['now', 'a', 'b', 'c']);
    q.move(1, 3);
    expect(q.upcoming).toEqual(['b', 'c', 'a']);
    q.move(3, 1);
    expect(q.upcoming).toEqual(['a', 'b', 'c']);
    expect(() => {
      q.move(0, 1);
    }).toThrow(/outside 1\.\.3/);
  });

  it('replaces its whole state', () => {
    const q = new Queue<string>();
    q.add(['x']);
    q.replace({ items: ['a', 'b', 'c'], index: 2, loop: 'track' });
    expect(q.current).toBe('c');
    expect(q.history).toEqual(['a', 'b']);
    expect(q.loop).toBe('track');
  });

  it('keeps the whole history under loop queue, so the loop can come back to it', () => {
    const items = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => `t${i}`);
    const q = new Queue<string>();
    q.add(items);
    q.loop = 'queue';
    for (let i = 0; i < HISTORY_LIMIT + 4; i++) q.advance('ended');
    expect(q.history).toHaveLength(HISTORY_LIMIT + 4);
  });

  it('trims exactly to the limit, not one less', () => {
    const q = new Queue<string>();
    q.add(Array.from({ length: HISTORY_LIMIT + 2 }, (_, i) => `t${i}`));
    for (let i = 0; i < HISTORY_LIMIT; i++) q.advance('skip');
    expect(q.history).toHaveLength(HISTORY_LIMIT);
    q.advance('skip');
    expect(q.history).toHaveLength(HISTORY_LIMIT);
    expect(q.history[0]).toBe('t1');
  });
});

describe('shuffled', () => {
  it('is a permutation and leaves its input alone', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer()),
        fc.infiniteStream(fc.double({ min: 0, max: 0.999999, noNaN: true })),
        (xs, rs) => {
          const copy = [...xs];
          const it = rs[Symbol.iterator]();
          const out = shuffled(xs, () => it.next().value as number);
          expect(xs).toEqual(copy);
          expect([...out].sort((a, b) => a - b)).toEqual([...xs].sort((a, b) => a - b));
        },
      ),
    );
  });

  it('follows Fisher–Yates for a given random source', () => {
    expect(shuffled([1, 2, 3], () => 0)).toEqual([2, 3, 1]);
    expect(shuffled([1, 2, 3], () => 0.999)).toEqual([1, 2, 3]);
  });
});

describe('mapping edges', () => {
  it('decodes each kind', () => {
    expect(decodeRef('t:1')).toEqual({ kind: 'track', id: '1' });
    expect(decodeRef('a:22')).toEqual({ kind: 'album', id: '22' });
    expect(decodeRef('p:333')).toEqual({ kind: 'playlist', id: '333' });
    expect(decodeRef('tt:1')).toBeUndefined();
    expect(decodeRef(' t:1')).toBeUndefined();
  });

  it('matches only a non-empty folded query', () => {
    expect(matches('Été indien', 'ete')).toBe(true);
    expect(matches('Été indien', '   ')).toBe(false);
    expect(matches('Été indien', 'été  ')).toBe(true);
    expect(matches('abc', 'abd')).toBe(false);
  });

  it('fills gaps in a track with sensible values', () => {
    const t = toTrack({ ratingKey: '9', type: 'track', title: 'X', thumb: '/t' });
    expect(t).toEqual({
      id: '9',
      title: 'X',
      artist: 'Artiste inconnu',
      album: '',
      year: undefined,
      durationMs: 0,
      thumb: '/t',
      library: '',
    });
    expect(toTrack(track({ year: 1999 })).year).toBe(1999);
    expect(toTrack(track({ year: 1999, parentYear: 2001 })).year).toBe(2001);
  });

  it('truncates at the limit exactly', () => {
    expect(truncate('abcd', 4)).toBe('abcd');
    expect(truncate('abc  defg', 6)).toBe('abc…');
  });

  it('writes the details of each kind of result', () => {
    const [plain] = toChoices([track({ parentTitle: undefined, librarySectionTitle: undefined })]);
    expect(plain?.name).toBe('🎵 T — A');
    const [bare] = toChoices([
      track({ grandparentTitle: undefined, parentTitle: undefined, librarySectionTitle: undefined }),
    ]);
    expect(bare?.name).toBe('🎵 T');
    const [album] = toChoices([
      track({ type: 'album', ratingKey: '2', parentTitle: 'Artist', year: undefined }),
    ]);
    expect(album?.name).toBe('💿 T — Artist · Musique');
    const [list] = toChoices([{ ratingKey: '3', type: 'playlist', title: 'P', playlistType: 'audio' }]);
    expect(list?.name).toBe('📜 P — playlist');
  });

  it('reads the gain of the audio stream only, album gain first', () => {
    const media = (streams: { streamType: number; gain?: number; albumGain?: number }[]) =>
      track({ Media: [{ Part: [{ key: '/k', Stream: streams }] }] });
    expect(trackGainDb(media([{ streamType: 2, gain: -3 }]))).toBe(-3);
    expect(trackGainDb(media([{ streamType: 2, gain: -3, albumGain: -5 }]))).toBe(-5);
    expect(trackGainDb(media([{ streamType: 4, gain: -9 }]))).toBeUndefined();
    expect(trackGainDb(track())).toBeUndefined();
  });
});
