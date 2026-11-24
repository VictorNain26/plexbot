import type { z } from 'zod';
import type { Track } from '../types.js';
import { type MediaRef, matches, toTrack, trackGainDb } from './mapping.js';
import {
  type Metadata,
  hubSearchSchema,
  metadataContainerSchema,
  sectionsSchema,
  ultraBlurSchema,
} from './schemas.js';

export interface PlexOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Stable per installation: Plex lists the bot as one device under this id. */
  readonly clientId: string;
  readonly version: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface Library {
  readonly id: number;
  readonly title: string;
}

/** What the audio pipeline needs to stream one track. */
export interface Playable {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly gainDb: number | undefined;
}

export class PlexError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    // The path only: the token travels in a header and never appears here.
    super(`Plex answered ${status} for ${path}`);
    this.name = 'PlexError';
  }
}

/** Upper bound on the tracks one playlist adds, so a huge one can't flood the queue. */
export const MAX_TRACKS_PER_ADD = 2000;
const PAGE_SIZE = 500;
const RETRIES = 2;

export class PlexClient {
  readonly #o: Required<PlexOptions>;
  #playlists: { at: number; items: Metadata[] } | undefined;

  constructor(options: PlexOptions) {
    this.#o = { fetch: globalThis.fetch.bind(globalThis), timeoutMs: 10_000, ...options };
  }

  /** Headers Plex documents for clients (X-Plex-Product, X-Plex-Client-Identifier, …). */
  get headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'X-Plex-Token': this.#o.token,
      'X-Plex-Client-Identifier': this.#o.clientId,
      'X-Plex-Product': 'plexbot',
      'X-Plex-Version': this.#o.version,
      'X-Plex-Platform': 'Discord',
      'X-Plex-Device-Name': 'plexbot',
    };
  }

  async musicLibraries(): Promise<Library[]> {
    const body = await this.#get('/library/sections', sectionsSchema);
    return body.MediaContainer.Directory.filter((d) => d.type === 'artist').map((d) => ({
      id: Number(d.key),
      title: d.title,
    }));
  }

  /**
   * Tracks and albums from `/hubs/search`, plus the audio playlists whose title matches:
   * the hub search never returns playlists, and its `sectionId` does not filter albums
   * (both checked against the server), so the library filter is applied by the caller.
   */
  async search(query: string): Promise<Metadata[]> {
    const [hubs, playlists] = await Promise.all([
      this.#get('/hubs/search', hubSearchSchema, { query, limit: '10' }),
      this.audioPlaylists(),
    ]);
    return [
      ...hubs.MediaContainer.Hub.flatMap((h) => h.Metadata),
      ...playlists.filter((p) => matches(p.title, query)),
    ];
  }

  /** The audio playlists, cached a minute: autocomplete asks on every keystroke. */
  async audioPlaylists(): Promise<Metadata[]> {
    const now = Date.now();
    if (this.#playlists && now - this.#playlists.at < 60_000) return this.#playlists.items;
    const body = await this.#get('/playlists', metadataContainerSchema, { playlistType: 'audio' });
    this.#playlists = { at: now, items: body.MediaContainer.Metadata };
    return this.#playlists.items;
  }

  /** The tracks a reference stands for: one track, an album's tracks, or a playlist's. */
  async tracks(ref: MediaRef): Promise<Track[]> {
    switch (ref.kind) {
      case 'track':
        return (await this.#metadata(`/library/metadata/${ref.id}`)).map(toTrack);
      case 'album': {
        const body = await this.#get(`/library/metadata/${ref.id}/children`, metadataContainerSchema);
        const library = body.MediaContainer.librarySectionTitle;
        return body.MediaContainer.Metadata.map((m) =>
          toTrack({ ...m, librarySectionTitle: m.librarySectionTitle ?? library }),
        );
      }
      case 'playlist':
        return (await this.#paged(`/playlists/${ref.id}/items`)).map(toTrack);
    }
  }

  async playable(trackId: string): Promise<Playable> {
    const [m] = await this.#metadata(`/library/metadata/${trackId}`);
    const partKey = m?.Media?.[0]?.Part[0]?.key;
    if (m === undefined || partKey === undefined) throw new PlexError(404, `/library/metadata/${trackId}`);
    return {
      url: new URL(partKey, this.#o.baseUrl).href,
      headers: { 'X-Plex-Token': this.#o.token, 'X-Plex-Client-Identifier': this.#o.clientId },
      gainDb: trackGainDb(m),
    };
  }

  /** A square JPEG of the cover, resized by Plex, for a Discord attachment. */
  async cover(thumb: string, size = 300): Promise<Buffer> {
    const res = await this.#request('/photo/:/transcode', {
      url: thumb,
      width: String(size),
      height: String(size),
      minSize: '1',
      upscale: '1',
      format: 'jpeg',
    });
    return Buffer.from(await res.arrayBuffer());
  }

  /** The dominant colour Plex computes for a cover (its « UltraBlur » colours), as 0xRRGGBB. */
  async accentColor(thumb: string): Promise<number | undefined> {
    const body = await this.#get('/services/ultrablur/colors', ultraBlurSchema, { url: thumb });
    const hex = body.MediaContainer.UltraBlurColors[0]?.topLeft;
    return hex !== undefined && /^[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex, 16) : undefined;
  }

  /** Reports playback so the bot shows in Plex's « Now Playing » and history. */
  async timeline(track: Track, state: 'playing' | 'paused' | 'stopped', timeMs: number): Promise<void> {
    await this.#request('/:/timeline', {
      ratingKey: track.id,
      key: `/library/metadata/${track.id}`,
      state,
      time: String(Math.round(timeMs)),
      duration: String(track.durationMs),
    });
  }

  /** Marks a track as played (play count and « last played »). */
  async scrobble(trackId: string): Promise<void> {
    await this.#request('/:/scrobble', { key: trackId, identifier: 'com.plexapp.plugins.library' });
  }

  async #metadata(path: string): Promise<Metadata[]> {
    return (await this.#get(path, metadataContainerSchema)).MediaContainer.Metadata;
  }

  async #paged(path: string): Promise<Metadata[]> {
    const all: Metadata[] = [];
    for (let start = 0; start < MAX_TRACKS_PER_ADD; start += PAGE_SIZE) {
      const body = await this.#get(path, metadataContainerSchema, {
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(Math.min(PAGE_SIZE, MAX_TRACKS_PER_ADD - start)),
      });
      all.push(...body.MediaContainer.Metadata);
      const total = body.MediaContainer.totalSize ?? all.length;
      if (body.MediaContainer.Metadata.length === 0 || all.length >= total) break;
    }
    return all.slice(0, MAX_TRACKS_PER_ADD);
  }

  async #get<S extends z.ZodType>(
    path: string,
    schema: S,
    params?: Record<string, string>,
  ): Promise<z.output<S>> {
    const res = await this.#request(path, params);
    return schema.parse(await res.json());
  }

  /** GET with a timeout; network errors and 5xx are retried twice, 4xx never. */
  async #request(path: string, params: Record<string, string> = {}): Promise<Response> {
    const url = new URL(path, this.#o.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.#o.fetch(url, {
          headers: this.headers,
          signal: AbortSignal.timeout(this.#o.timeoutMs),
        });
        if (res.ok) return res;
        await res.body?.cancel();
        if (res.status < 500 || attempt >= RETRIES) throw new PlexError(res.status, path);
      } catch (err) {
        if (err instanceof PlexError || attempt >= RETRIES) throw err;
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}
