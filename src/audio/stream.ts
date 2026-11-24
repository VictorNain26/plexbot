import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { Readable, type Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Playable } from '../plex/client.js';

/** Gain applied from Plex's loudness analysis is kept in a sane range. */
export const MIN_GAIN_DB = -20;
export const MAX_GAIN_DB = 10;
/** Discord's minimum channel bitrate (Modify Channel), and the bitrate Opus is transparent at for music. */
export const MIN_BITRATE = 8_000;
export const MAX_BITRATE = 128_000;
/** The bitrate of a default voice channel, used when the channel's is unknown. */
export const DEFAULT_BITRATE = 64_000;
/** -1 dBTP as a linear ceiling: 10^(-1/20). */
export const TRUE_PEAK_LIMIT = 0.891;

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
  // boost gets the lookahead limiter, its auto level off so it keeps the gain (alimiter). Its ceiling
  // is -1 dBTP (0.891), the true-peak maximum EBU R128 sets, which leaves the lossy Opus encode room.
  return total > 0 ? `${volumeStep},alimiter=limit=${TRUE_PEAK_LIMIT}:level=disabled` : volumeStep;
}

/**
 * ffmpeg encodes Opus itself, in its own process, into Ogg; @discordjs/voice then only demuxes it
 * (StreamType.OggOpus): the Opus encoding, « one of the most computationally demanding parts of
 * the audio pipeline » (discord.js guide, audio resources), stays off the Node thread that sends a
 * packet every 20 ms. Settings are libopus's for music (ffmpeg-codecs, libopus): audio application,
 * VBR, 20 ms frames.
 *
 * ffmpeg reads the file on its standard input (`pipe:0`): Node fetches it from Plex with the token
 * in a request header (startFfmpeg). A process's arguments are visible to every user of the host
 * (`ps`), so neither the token nor the Plex URL is ever one of them. A seek is an output option,
 * which decodes the pipe up to the position (ffmpeg, -ss).
 */
export function ffmpegArgs(p: Playable, options: StreamOptions = {}): string[] {
  const bitrate = Math.min(
    Math.max(Math.round(options.bitrate ?? DEFAULT_BITRATE), MIN_BITRATE),
    MAX_BITRATE,
  );
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn'];
  if (options.seekMs !== undefined && options.seekMs > 0)
    args.push('-ss', (options.seekMs / 1000).toFixed(3));
  const filter = volumeFilter(p.gainDb, options.volume);
  if (filter) args.push('-af', filter);
  args.push('-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'on', '-application', 'audio');
  args.push('-frame_duration', '20', '-compression_level', '10');
  args.push('-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1');
  return args;
}

export type Ffmpeg = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * Starts ffmpeg and feeds it the Plex file, fetched by Node with its headers. The download stops
 * with ffmpeg; a failed download ends ffmpeg's input, so the stream ends (and the player moves on).
 * Its stderr is collected (bounded) for the error report.
 */
export function startFfmpeg(
  p: Playable,
  options: StreamOptions = {},
  binary = 'ffmpeg',
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): { process: Ffmpeg; stderr: () => string } {
  const child = spawn(binary, ffmpegArgs(p, options), { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  const note = (text: string) => {
    err = (err + text).slice(-2000);
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', note);
  // ffmpeg may stop reading first (killed on a skip): that is not an error.
  child.stdin.on('error', () => undefined);

  const download = new AbortController();
  child.on('close', () => {
    download.abort();
  });
  fetchFn(p.url, { headers: p.headers, signal: download.signal })
    .then((res) => {
      if (!res.ok || !res.body) throw new Error(`Plex answered ${res.status} for the audio file`);
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>).pipe(child.stdin);
    })
    .catch((e: unknown) => {
      if (!download.signal.aborted) note(`download failed: ${e instanceof Error ? e.message : String(e)}\n`);
      child.stdin.end();
    });
  return { process: child, stderr: () => err.trim() };
}
