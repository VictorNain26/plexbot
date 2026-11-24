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
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('reads the Plex URL with the token in a header', () => {
    const args = ffmpegArgs(playable);
    expect(args).not.toContain('http://plex:32400/library/parts/1/file.flac?X-Plex-Token=tok');
    expect(value(args, '-headers')).toBe('X-Plex-Token: tok\r\n');
    expect(args.indexOf('-ss')).toBe(-1);
  });

  it('encodes Opus music in ffmpeg, in Ogg, at the given bitrate', () => {
    const args = ffmpegArgs(playable, { bitrate: 96_000 });
    expect(value(args, '-c:a')).toBe('libopus');
    expect(value(args, '-b:a')).toBe('96000');
    expect(value(args, '-vbr')).toBe('on');
    expect(value(args, '-application')).toBe('audio');
    expect(value(args, '-frame_duration')).toBe('20');
    expect(value(args, '-compression_level')).toBe('10');
    expect(args.slice(-7)).toEqual(['-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1']);
  });

  it('keeps the bitrate between Discord’s minimum and the transparent 128 kb/s', () => {
    expect(value(ffmpegArgs(playable, { bitrate: 384_000 }), '-b:a')).toBe('128000');
    expect(value(ffmpegArgs(playable, { bitrate: 1_000 }), '-b:a')).toBe('8000');
    expect(value(ffmpegArgs(playable), '-b:a')).toBe('64000');
  });

  it('adds the volume to the Plex gain, without a limiter when the total is a cut', () => {
    expect(value(ffmpegArgs(playable, { volume: 100 }), '-af')).toBe('volume=-10.36dB');
    expect(value(ffmpegArgs(playable, { volume: 50 }), '-af')).toBe('volume=-16.38dB');
  });

  it('limits peaks only when the total gain is a boost', () => {
    const af = value(ffmpegArgs({ ...playable, gainDb: 4 }, { volume: 100 }), '-af');
    expect(af).toBe('volume=4.00dB,alimiter=limit=1:level=disabled');
  });

  it('mutes at volume 0, clamps the Plex gain, and needs no filter at a neutral setting', () => {
    expect(value(ffmpegArgs(playable, { volume: 0 }), '-af')).toBe('volume=0');
    expect(value(ffmpegArgs({ ...playable, gainDb: -40 }), '-af')).toBe('volume=-20.00dB');
    expect(ffmpegArgs({ ...playable, gainDb: undefined }, { volume: 100 })).not.toContain('-af');
  });

  it('seeks before the input', () => {
    const args = ffmpegArgs(playable, { seekMs: 61_500 });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(value(args, '-ss')).toBe('61.500');
  });
});
