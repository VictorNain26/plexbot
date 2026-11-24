import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { QueueEntry } from '../types.js';

/** What survives a restart: the queue, where it was, and the channels to go back to. */
export interface SavedSession {
  readonly voiceChannelId: string;
  readonly textChannelId: string;
  readonly items: readonly QueueEntry[];
  readonly index: number;
  readonly loop: 'off' | 'track' | 'queue';
  readonly volume: number;
  readonly positionMs: number;
  readonly paused: boolean;
  /** The « now playing » card of the session: deleted on restore, a new one replaces it. */
  readonly cardMessageId?: string | undefined;
}

const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  year: z.number().optional(),
  durationMs: z.number(),
  thumb: z.string().optional(),
  library: z.string(),
});

const savedSchema = z.object({
  voiceChannelId: z.string(),
  textChannelId: z.string(),
  items: z.array(
    z.object({
      uid: z.string(),
      track: trackSchema,
      requestedBy: z.object({ id: z.string(), name: z.string() }),
    }),
  ),
  index: z.number().int(),
  loop: z.enum(['off', 'track', 'queue']),
  volume: z.number(),
  positionMs: z.number(),
  paused: z.boolean(),
  cardMessageId: z.string().optional(),
});

/** One row per guild in a SQLite file (node:sqlite, built into Node). */
export class Store {
  readonly #db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#db = new DatabaseSync(join(dataDir, 'plexbot.db'));
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    );
  }

  save(guildId: string, session: SavedSession): void {
    this.#db
      .prepare(
        'INSERT INTO sessions (guild_id, data, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      )
      .run(guildId, JSON.stringify(session), Date.now());
  }

  /** A saved session, or undefined when there is none or it no longer reads (it is then dropped). */
  load(guildId: string): SavedSession | undefined {
    const row = this.#db.prepare('SELECT data FROM sessions WHERE guild_id = ?').get(guildId) as
      { data: string } | undefined;
    if (!row) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      data = undefined;
    }
    const parsed = savedSchema.safeParse(data);
    if (!parsed.success) {
      this.delete(guildId);
      return undefined;
    }
    const s = parsed.data;
    return {
      ...s,
      items: s.items.map((e) => ({ ...e, track: { ...e.track, year: e.track.year, thumb: e.track.thumb } })),
    };
  }

  delete(guildId: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE guild_id = ?').run(guildId);
  }

  close(): void {
    this.#db.close();
  }
}
