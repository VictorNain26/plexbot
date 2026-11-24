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
});
