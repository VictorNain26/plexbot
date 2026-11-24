import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ffmpegArgs } from '../src/audio/stream.js';
import { escapeMarkdown, formatDuration, parseDuration, progressBar } from '../src/ui/format.js';

describe('durations', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(187_400)).toBe('3:07');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });

  it('parses seconds, m:ss and h:mm:ss, and refuses the rest', () => {
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('1:30')).toBe(90_000);
    expect(parseDuration(' 1:02:03 ')).toBe(3_723_000);
    for (const bad of ['', 'abc', '1:60', '1:60:00', '1:2:3:4', '-5', '1.5'])
      expect(parseDuration(bad)).toBeUndefined();
  });

  it('reads back what it formats, to the second', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 * 3600 }), (seconds) => {
        expect(parseDuration(formatDuration(seconds * 1000))).toBe(seconds * 1000);
      }),
    );
  });
});

describe('progressBar', () => {
  it('has a fixed width and fills with time', () => {
    expect(progressBar(0, 100, 4)).toBe('▱▱▱▱');
    expect(progressBar(50, 100, 4)).toBe('▰▰▱▱');
    expect(progressBar(500, 100, 4)).toBe('▰▰▰▰');
    expect(progressBar(10, 0, 4)).toBe('▱▱▱▱');
  });

  it('always has the requested width', () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), fc.integer({ min: 1, max: 40 }), (a, b, w) => {
        expect(Array.from(progressBar(a, b, w))).toHaveLength(w);
      }),
    );
  });
});

describe('escapeMarkdown', () => {
  it('escapes what Discord would format', () => {
    expect(escapeMarkdown('*NSYNC_Live')).toBe('\\*NSYNC\\_Live');
  });
});

describe('ffmpegArgs', () => {
  const playable = {
    url: 'http://plex:32400/library/parts/1/file.flac',
    headers: { 'X-Plex-Token': 'tok' },
    gainDb: -10.36,
  };

  it('reads the Plex URL with the token in a header and writes 48 kHz stereo PCM', () => {
    const args = ffmpegArgs(playable);
    expect(args.join(' ')).not.toContain('tok@');
    expect(args).not.toContain('http://plex:32400/library/parts/1/file.flac?X-Plex-Token=tok');
    expect(args[args.indexOf('-headers') + 1]).toBe('X-Plex-Token: tok\r\n');
    expect(args.slice(-7)).toEqual(['-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
    expect(args.indexOf('-ss')).toBe(-1);
  });

  it('applies the gain, clamped, and seeks before the input', () => {
    const args = ffmpegArgs({ ...playable, gainDb: -40 }, 61_500);
    expect(args[args.indexOf('-af') + 1]).toMatch(/^volume=-20\.00dB,/);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('61.500');
  });

  it('adds no filter without a measured gain', () => {
    expect(ffmpegArgs({ ...playable, gainDb: undefined })).not.toContain('-af');
  });
});
