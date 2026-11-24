import type { Track } from '../types.js';
import type { Metadata } from './schemas.js';

export type MediaKind = 'track' | 'album' | 'playlist';

/** What the autocomplete returns to Discord as an option value, and the bot reads back. */
export interface MediaRef {
  readonly kind: MediaKind;
  readonly id: string;
}

const KIND_CODES: Record<MediaKind, string> = { track: 't', album: 'a', playlist: 'p' };
const CODE_KINDS = new Map(Object.entries(KIND_CODES).map(([kind, code]) => [code, kind as MediaKind]));

/** Plex ratingKeys are decimal integers; anything else is refused before it reaches a URL. */
const RATING_KEY = /^[0-9]{1,12}$/;

export function encodeRef(ref: MediaRef): string {
  return `${KIND_CODES[ref.kind]}:${ref.id}`;
}

/** Reads an option value back; returns undefined for free text or anything malformed. */
export function decodeRef(value: string): MediaRef | undefined {
  const match = /^([tap]):(.+)$/.exec(value);
  if (!match) return undefined;
  const kind = CODE_KINDS.get(match[1] ?? '');
  const id = match[2] ?? '';
  if (kind === undefined || !RATING_KEY.test(id)) return undefined;
  return { kind, id };
}

/** Folds case and accents, so « amoureuse » finds « L'Amoureuse ». */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function matches(title: string, query: string): boolean {
  const q = fold(query).trim();
  return q.length > 0 && fold(title).includes(q);
}

export function toTrack(m: Metadata): Track {
  return {
    id: m.ratingKey,
    title: m.title,
    // A compilation track names its own artist in originalTitle.
    artist: m.originalTitle ?? m.grandparentTitle ?? 'Artiste inconnu',
    album: m.parentTitle ?? '',
    year: m.parentYear ?? m.year,
    durationMs: m.duration ?? 0,
    thumb: m.parentThumb ?? m.thumb,
    library: m.librarySectionTitle ?? '',
  };
}

/** Discord limits a choice name to 100 characters. */
export const CHOICE_NAME_MAX = 100;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface Choice {
  readonly name: string;
  readonly value: string;
}

const ICONS: Record<MediaKind, string> = { track: '🎵', album: '💿', playlist: '📜' };

/** One autocomplete line per result: icon, what it is, and the library it comes from. */
export function toChoice(m: Metadata): Choice | undefined {
  let kind: MediaKind;
  let detail: string;
  if (m.type === 'track') {
    kind = 'track';
    detail = [m.originalTitle ?? m.grandparentTitle, m.parentTitle, m.librarySectionTitle]
      .filter(Boolean)
      .join(' · ');
  } else if (m.type === 'album') {
    kind = 'album';
    detail = [m.parentTitle, m.year, m.librarySectionTitle].filter(Boolean).join(' · ');
  } else if (m.type === 'playlist' && m.playlistType === 'audio') {
    kind = 'playlist';
    detail = m.leafCount === undefined ? 'playlist' : `playlist · ${m.leafCount} titres`;
  } else {
    return undefined;
  }
  const name = truncate(`${ICONS[kind]} ${m.title}${detail ? ` — ${detail}` : ''}`, CHOICE_NAME_MAX);
  return { name, value: encodeRef({ kind, id: m.ratingKey }) };
}

/**
 * Search results as autocomplete choices: tracks, then albums, then playlists, at most `limit`
 * (Discord shows 25). With `sectionId`, only that library's tracks and albums stay; playlists
 * span libraries and always stay.
 */
export function toChoices(
  items: readonly Metadata[],
  options: { sectionId?: number | undefined; limit?: number } = {},
): Choice[] {
  const order: Record<string, number> = { track: 0, album: 1, playlist: 2 };
  return items
    .filter(
      (m) =>
        options.sectionId === undefined || m.type === 'playlist' || m.librarySectionID === options.sectionId,
    )
    .filter((m) => m.type in order)
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
    .map(toChoice)
    .filter((c): c is Choice => c !== undefined)
    .slice(0, options.limit ?? 25);
}

/** Loudness gain Plex measured for a track (dB), album gain first so an album keeps its dynamics. */
export function trackGainDb(m: Metadata): number | undefined {
  const audio = m.Media?.[0]?.Part[0]?.Stream?.find((s) => s.streamType === 2);
  return audio?.albumGain ?? audio?.gain;
}
