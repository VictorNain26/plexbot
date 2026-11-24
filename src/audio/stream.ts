import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Playable } from '../plex/client.js';

/** Gain applied from Plex's loudness analysis is kept in a sane range. */
export const MIN_GAIN_DB = -20;
export const MAX_GAIN_DB = 10;
/** Discord's minimum channel bitrate (Modify Channel), and the bitrate Opus is transparent at for music. */
export const MIN_BITRATE = 8_000;
export const MAX_BITRATE = 128_000;
/** The bitrate of a default voice channel, used when the channel's is unknown. */
export const DEFAULT_BITRATE = 64_000;

export interface StreamOptions {
  readonly seekMs?: number | undefined;
  /** The voice channel's bitrate (channel.bitrate), in bits per second. */
  readonly bitrate?: number | undefined;
  /** The bot's volume, in percent (100 = unchanged). */
  readonly volume?: number | undefined;
}

/** The `-af` filter for the Plex gain plus the bot's volume, or undefined when it changes nothing. */
export function volumeFilter(gainDb: number | undefined, volume = 100): string | undefined {
  if (volume <= 0) return 'volume=0';
  const plex = gainDb === undefined ? 0 : Math.min(Math.max(gainDb, MIN_GAIN_DB), MAX_GAIN_DB);
  const total = plex + 20 * Math.log10(volume / 100);
  if (Math.abs(total) < 0.005) return undefined;
  const volumeStep = `volume=${total.toFixed(2)}dB`;
  // `volume` clips what goes over full scale (ffmpeg-filters, volume): only a boost can, so only a
  // boost gets the lookahead limiter, with its auto level off so it keeps the gain (alimiter).
  return total > 0 ? `${volumeStep},alimiter=limit=1:level=disabled` : volumeStep;
}

/**
 * ffmpeg reads the original file from Plex (no transcoding on Plex's side) and encodes Opus
 * itself, in its own process, into Ogg. @discordjs/voice then only demuxes it (StreamType.OggOpus):
 * the Opus encoding, « one of the most computationally demanding parts of the audio pipeline »
 * (discord.js guide, audio resources), stays off the Node thread that sends a packet every 20 ms.
 * Settings are libopus's for music (ffmpeg-codecs, libopus): audio application, VBR, 20 ms frames.
 * The token goes in a request header: it never appears in the URL, so in no ffmpeg message.
 */
export function ffmpegArgs(p: Playable, options: StreamOptions = {}): string[] {
  const headers = Object.entries(p.headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  const bitrate = Math.min(
    Math.max(Math.round(options.bitrate ?? DEFAULT_BITRATE), MIN_BITRATE),
    MAX_BITRATE,
  );
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (headers) args.push('-headers', headers);
  if (options.seekMs !== undefined && options.seekMs > 0)
    args.push('-ss', (options.seekMs / 1000).toFixed(3));
  args.push('-i', p.url, '-vn');
  const filter = volumeFilter(p.gainDb, options.volume);
  if (filter) args.push('-af', filter);
  args.push('-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'on', '-application', 'audio');
  args.push('-frame_duration', '20', '-compression_level', '10');
  args.push('-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1');
  return args;
}

export type Ffmpeg = ChildProcessByStdio<null, Readable, Readable>;

/** Starts ffmpeg; its stderr is collected (bounded) for the error report. */
export function startFfmpeg(
  p: Playable,
  options: StreamOptions = {},
  binary = 'ffmpeg',
): { process: Ffmpeg; stderr: () => string } {
  const child = spawn(binary, ffmpegArgs(p, options), { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err = (err + chunk).slice(-2000);
  });
  return { process: child, stderr: () => err.trim() };
}
