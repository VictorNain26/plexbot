import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Playable } from '../plex/client.js';

/** Gain applied from Plex's loudness analysis is kept in a sane range. */
export const MIN_GAIN_DB = -20;
export const MAX_GAIN_DB = 10;

/**
 * ffmpeg arguments that read the original file from Plex (no transcoding on Plex's side) and
 * write raw 48 kHz stereo PCM, which @discordjs/voice encodes to Opus itself (StreamType.Raw).
 * The token goes in a request header: it never appears in the URL, and so in no ffmpeg message.
 */
export function ffmpegArgs(p: Playable, seekMs = 0): string[] {
  const headers = Object.entries(p.headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (headers) args.push('-headers', headers);
  if (seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3));
  args.push('-i', p.url, '-vn');
  if (p.gainDb !== undefined) {
    const gain = Math.min(Math.max(p.gainDb, MIN_GAIN_DB), MAX_GAIN_DB);
    // Plex's gain brings the track to its reference loudness; the limiter keeps a raised quiet
    // track from clipping (ffmpeg filters: volume, alimiter).
    args.push('-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:level=disabled`);
  }
  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
  return args;
}

export type Ffmpeg = ChildProcessByStdio<null, Readable, Readable>;

/** Starts ffmpeg; its stderr is collected (bounded) for the error report. */
export function startFfmpeg(
  p: Playable,
  seekMs = 0,
  binary = 'ffmpeg',
): { process: Ffmpeg; stderr: () => string } {
  const child = spawn(binary, ffmpegArgs(p, seekMs), { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    err = (err + chunk).slice(-2000);
  });
  return { process: child, stderr: () => err.trim() };
}
