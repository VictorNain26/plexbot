import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamType, createAudioResource } from '@discordjs/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFfmpeg } from '../src/audio/stream.js';

/**
 * The real pipeline, minus Discord and Plex: ffmpeg reads a FLAC over HTTP (with the token
 * header), encodes Opus into Ogg, and @discordjs/voice turns it into the 20 ms Opus packets it
 * sends, with no Opus library installed in Node (the encoding is ffmpeg's).
 */
describe('audio pipeline (real ffmpeg)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plexbot-audio-'));
  const flac = join(dir, 'tone.flac');
  let url = '';
  let seenToken: string | undefined;
  const server = createServer((req, res) => {
    seenToken = req.headers['x-plex-token'] as string | undefined;
    if (req.url?.includes('slow')) {
      // A long file sent slowly: still downloading when ffmpeg is killed (a skip).
      res.writeHead(200, { 'Content-Type': 'audio/flac' });
      const body = readFileSync(flac);
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= body.length || res.destroyed) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(body.subarray(sent, sent + 4096));
        sent += 4096;
      }, 50);
      return;
    }
    if (req.url?.includes('missing')) {
      res.writeHead(404).end('<html>Not Found</html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/flac' });
    res.end(readFileSync(flac));
  });

  beforeAll(async () => {
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-ac',
      '2',
      flac,
    ]);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/library/parts/1/file.flac`;
  });

  afterAll(() => {
    server.close();
  });

  it('gives @discordjs/voice Opus packets it can send', async () => {
    const { process: ffmpeg, stderr } = startFfmpeg(
      { url, headers: { 'X-Plex-Token': 'secret' }, gainDb: -6 },
      { bitrate: 96_000, volume: 100 },
    );
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    const packets: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      resource.playStream.on('readable', () => {
        let packet: Buffer | null;
        while ((packet = resource.playStream.read() as Buffer | null) !== null) packets.push(packet);
      });
      resource.playStream.on('end', resolve);
      resource.playStream.on('error', reject);
    });
    expect(stderr()).toBe('');
    expect(seenToken).toBe('secret');
    // 3 s of audio at 20 ms per packet: about 150 packets, each a small Opus frame.
    expect(packets.length).toBeGreaterThanOrEqual(140);
    expect(packets.length).toBeLessThanOrEqual(160);
    expect(packets.every((p) => p.length > 0 && p.length < 1500)).toBe(true);
  });

  /** Every packet @discordjs/voice reads from a stream. */
  async function packetsOf(seekMs: number, file = url) {
    const { process: ffmpeg, stderr } = startFfmpeg(
      { url: file, headers: { 'X-Plex-Token': 'secret' }, gainDb: undefined },
      { seekMs },
    );
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    const packets: Buffer[] = [];
    await new Promise<void>((resolve) => {
      resource.playStream.on('readable', () => {
        let packet: Buffer | null;
        while ((packet = resource.playStream.read() as Buffer | null) !== null) packets.push(packet);
      });
      resource.playStream.on('end', resolve);
      resource.playStream.on('close', resolve);
    });
    return { packets, stderr: stderr() };
  }

  it('seeks into the piped file', async () => {
    const { packets } = await packetsOf(1_000);
    // 2 s left of 3 s: about 100 packets.
    expect(packets.length).toBeGreaterThanOrEqual(90);
    expect(packets.length).toBeLessThanOrEqual(110);
  });

  it('ends the stream and reports it when Plex refuses the file', async () => {
    const { packets, stderr } = await packetsOf(0, url.replace('file.flac', 'missing.flac'));
    expect(packets).toHaveLength(0);
    expect(stderr).toContain('download failed: Plex answered 404');
  });

  it('survives ffmpeg being killed while the download runs (a skip)', async () => {
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onError);
    try {
      const { process: ffmpeg } = startFfmpeg(
        { url: url.replace('file.flac', 'slow.flac'), headers: {}, gainDb: undefined },
        {},
      );
      ffmpeg.stdout.resume();
      await new Promise((r) => setTimeout(r, 300));
      ffmpeg.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onError);
    }
  });
});
