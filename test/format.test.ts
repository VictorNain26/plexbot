import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ffmpegArgs, MAX_GAIN_DB, MIN_GAIN_DB, startFfmpeg, volumeFilter } from '../src/audio/stream.js';
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
    expect(af).toBe('volume=4.00dB,alimiter=limit=0.891:level=disabled');
  });

  it('mutes at volume 0, clamps the Plex gain, and needs no filter at a neutral setting', () => {
    expect(value(ffmpegArgs(playable, { volume: 0 }), '-af')).toBe('volume=0');
    expect(value(ffmpegArgs({ ...playable, gainDb: -40 }), '-af')).toBe('volume=-20.00dB');
    expect(ffmpegArgs({ ...playable, gainDb: undefined }, { volume: 100 })).not.toContain('-af');
  });

  it('starts quiet, reconnects on a dropped stream, and sends every header', () => {
    const args = ffmpegArgs({ ...playable, headers: { A: '1', B: '2' } });
    expect(args.slice(0, 10)).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
    ]);
    expect(value(args, '-headers')).toBe('A: 1\r\nB: 2\r\n');
    expect(ffmpegArgs({ ...playable, headers: {} })).not.toContain('-headers');
  });

  it('reads the original file without video', () => {
    const args = ffmpegArgs(playable);
    expect(args[args.indexOf('-i') + 2]).toBe('-vn');
  });

  it('seeks before the input', () => {
    const args = ffmpegArgs(playable, { seekMs: 61_500 });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(value(args, '-ss')).toBe('61.500');
  });
});

describe('startFfmpeg', () => {
  it('runs the binary with the arguments and keeps the end of its error output', async () => {
    // Node refuses ffmpeg's first option with a fixed message: enough to check the plumbing.
    const { process: child, stderr } = startFfmpeg(
      { url: 'http://x', headers: {}, gainDb: undefined },
      {},
      process.execPath,
    );
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).not.toBe(0);
    expect(stderr()).toContain('bad option: -hide_banner');
    expect(stderr()).toBe(stderr().trim());
  });
});

describe('volumeFilter properties', () => {
  it('limits only a boost, mutes at 0, and stays within the clamped gain', () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ min: -100, max: 100, noNaN: true }), { nil: undefined }),
        fc.integer({ min: 0, max: 150 }),
        (gain, volume) => {
          const f = volumeFilter(gain, volume);
          if (volume === 0) {
            expect(f).toBe('volume=0');
            return;
          }
          if (f === undefined) return;
          const db = Number(/^volume=(-?[0-9.]+)dB/.exec(f)?.[1]);
          expect(f.includes('alimiter')).toBe(db > 0);
          expect(db).toBeLessThanOrEqual(MAX_GAIN_DB + 20 * Math.log10(1.5) + 0.01);
          expect(db).toBeGreaterThanOrEqual(MIN_GAIN_DB + 20 * Math.log10(0.01) - 0.01);
        },
      ),
    );
  });

  it('keeps true peaks under -1 dBTP on a boost (EBU R128)', () => {
    expect(volumeFilter(4, 100)).toBe('volume=4.00dB,alimiter=limit=0.891:level=disabled');
  });
});
