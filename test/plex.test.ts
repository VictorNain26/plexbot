import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PlexClient, PlexError } from '../src/plex/client.js';
import {
  CHOICE_NAME_MAX,
  decodeRef,
  encodeRef,
  fold,
  toChoices,
  toTrack,
  truncate,
} from '../src/plex/mapping.js';
import { hubSearchSchema, metadataContainerSchema } from '../src/plex/schemas.js';

// Fixtures are real answers of the Plex server, trimmed to the fields the bot reads.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

/** The item at `index`, failing the test if it is missing. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

const searchItems = hubSearchSchema.parse(fixture('search')).MediaContainer.Hub.flatMap((h) => h.Metadata);
const playlists = metadataContainerSchema.parse(fixture('playlists')).MediaContainer.Metadata;

describe('media references', () => {
  it('round-trips every kind and rating key', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('track', 'album', 'playlist' as const),
        fc.stringMatching(/^[0-9]{1,12}$/),
        (kind, id) => {
          expect(decodeRef(encodeRef({ kind, id }))).toEqual({ kind, id });
        },
      ),
    );
  });

  it('refuses free text and keys that are not plain numbers', () => {
    for (const value of [
      'sleeping',
      't:',
      'x:12',
      't:12/../..',
      't:12?X-Plex-Token=1',
      'a:1e3',
      't:1234567890123',
    ]) {
      expect(decodeRef(value)).toBeUndefined();
    }
  });
});

describe('search choices', () => {
  it('lists tracks, then albums, then playlists, each with its library', () => {
    const choices = toChoices([...playlists, ...searchItems]);
    expect(choices.map((c) => c.value)).toEqual(['t:187670', 't:299013', 'a:308202', 'p:324581']);
    expect(choices[0]?.name).toBe('🎵 Sleeping In — The Postal Service · Give Up · Musique');
    expect(choices[2]?.name).toBe('💿 Sleeping With Ghosts — Placebo · 2003 · Musique second wave');
    expect(choices[3]?.name).toBe("📜 L'amoureuse — playlist · 29 titres");
  });

  it('keeps one library, and the playlists, when a library is chosen', () => {
    const values = toChoices([...searchItems, ...playlists], { sectionId: 9 }).map((c) => c.value);
    expect(values).toEqual(['t:299013', 'a:308202', 'p:324581']);
  });

  it('drops what is not music: shows, video playlists', () => {
    const video = { ...at(playlists, 0), ratingKey: '1', playlistType: 'video' };
    const show = { ...at(searchItems, 0), ratingKey: '2', type: 'show' };
    expect(toChoices([video, show])).toEqual([]);
  });

  it('never gives Discord a name over 100 characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 300 }), (title, artist) => {
        const [choice] = toChoices([{ ...at(searchItems, 1), title, grandparentTitle: artist }]);
        expect(choice?.name.length).toBeLessThanOrEqual(CHOICE_NAME_MAX);
      }),
    );
  });

  it('caps the number of choices', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...at(searchItems, 1), ratingKey: String(i) }));
    expect(toChoices(many)).toHaveLength(25);
  });
});

describe('text helpers', () => {
  it('truncates with an ellipsis and keeps short text', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });

  it('folds case and accents', () => {
    expect(fold("L'Amoureuse Été")).toBe("l'amoureuse ete");
  });
});

describe('toTrack', () => {
  it('maps a Plex track', () => {
    expect(toTrack(at(metadataContainerSchema.parse(fixture('track')).MediaContainer.Metadata, 0))).toEqual({
      id: '187670',
      title: 'Sleeping In',
      artist: 'The Postal Service',
      album: 'Give Up',
      year: 2003,
      durationMs: 261093,
      thumb: '/library/metadata/187667/thumb/1784341892',
      library: 'Musique',
    });
  });

  it('prefers the track artist of a compilation', () => {
    expect(
      toTrack({
        ...at(metadataContainerSchema.parse(fixture('track')).MediaContainer.Metadata, 0),
        originalTitle: 'Guest',
      }).artist,
    ).toBe('Guest');
  });
});

/** A fetch that answers from fixtures, by path, and records what it was asked. */
function fakePlex(routes: Record<string, unknown>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const route = routes[url.pathname];
    if (route === undefined) return Promise.resolve(new Response('<html>Not Found</html>', { status: 404 }));
    if (typeof route === 'number')
      return Promise.resolve(new Response('<html>error</html>', { status: route }));
    return Promise.resolve(Response.json(route));
  }) as typeof fetch;
  const client = new PlexClient({
    baseUrl: 'http://plex.test:32400',
    token: 'secret-token',
    clientId: 'plexbot-test',
    version: '1.0.0',
    fetch: fetchFn,
  });
  return { client, calls };
}

describe('PlexClient', () => {
  it('sends the token in a header, never in the URL', async () => {
    const { client, calls } = fakePlex({ '/library/sections': fixture('sections') });
    await client.musicLibraries();
    expect(calls[0]?.url.href).not.toContain('secret-token');
    expect(calls[0]?.headers['X-Plex-Token']).toBe('secret-token');
    expect(calls[0]?.headers.Accept).toBe('application/json');
  });

  it('lists only the music libraries', async () => {
    const { client } = fakePlex({ '/library/sections': fixture('sections') });
    expect(await client.musicLibraries()).toEqual([
      { id: 8, title: 'Musique' },
      { id: 9, title: 'Musique second wave' },
    ]);
  });

  it('searches the hubs and the playlists, folding accents', async () => {
    const { client } = fakePlex({ '/hubs/search': fixture('search'), '/playlists': fixture('playlists') });
    const found = await client.search('AMOUREUSE');
    expect(found.map((m) => m.ratingKey)).toContain('324581');
  });

  it('resolves an album to its tracks, with the library of the album', async () => {
    const { client, calls } = fakePlex({ '/library/metadata/308202/children': fixture('album') });
    const tracks = await client.tracks({ kind: 'album', id: '308202' });
    expect(tracks.map((t) => t.title)).toEqual(['Bulletproof Cupid', 'English Summer Rain']);
    expect(tracks.every((t) => t.library === 'Musique second wave')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('resolves a playlist page by page', async () => {
    const { client, calls } = fakePlex({ '/playlists/324581/items': fixture('playlist-items') });
    const tracks = await client.tracks({ kind: 'playlist', id: '324581' });
    expect(tracks.map((t) => t.id)).toEqual(['187670', '324377']);
    expect(calls[0]?.url.searchParams.get('X-Plex-Container-Start')).toBe('0');
  });

  it('gives a stream URL without the token, and the album gain', async () => {
    const { client } = fakePlex({ '/library/metadata/187670': fixture('track') });
    const p = await client.playable('187670');
    expect(p.url).toBe('http://plex.test:32400/library/parts/170566/1769175385/file.flac');
    expect(p.headers['X-Plex-Token']).toBe('secret-token');
    expect(p.gainDb).toBe(-10.36);
  });

  it('turns an HTML error page into a PlexError instead of a JSON crash', async () => {
    const { client } = fakePlex({});
    await expect(client.tracks({ kind: 'track', id: '1' })).rejects.toBeInstanceOf(PlexError);
    await expect(client.tracks({ kind: 'track', id: '1' })).rejects.not.toThrow(/secret-token/);
  });

  it('retries a 5xx, not a 4xx', async () => {
    const failing = fakePlex({ '/library/sections': 503 });
    await expect(failing.client.musicLibraries()).rejects.toMatchObject({ status: 503 });
    expect(failing.calls).toHaveLength(3);
    const missing = fakePlex({ '/library/sections': 401 });
    await expect(missing.client.musicLibraries()).rejects.toMatchObject({ status: 401 });
    expect(missing.calls).toHaveLength(1);
  });
});
