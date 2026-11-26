import { MessageFlags, MessageFlagsBitField, type SendableChannels } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { GuildSession, type SessionDeps } from '../src/audio/session.js';
import type { QueueEntry } from '../src/types.js';

const entry: QueueEntry = {
  uid: 'u1',
  track: {
    id: '101',
    title: 'Titre',
    artist: 'Artiste',
    album: 'Album',
    year: 2003,
    durationMs: 200_000,
    thumb: undefined,
    library: 'Musique',
  },
  requestedBy: { id: '1', name: 'Victor' },
};

describe('the now playing card', () => {
  it('is posted silently, so a new track makes no notification sound', async () => {
    const sent: { flags?: unknown }[] = [];
    const channel = {
      id: 'c',
      send: (payload: { flags?: unknown }) => {
        sent.push(payload);
        return Promise.resolve({ delete: () => Promise.resolve(), edit: () => Promise.resolve() });
      },
    } as unknown as SendableChannels;
    const noop = () => undefined;
    const session = new GuildSession({
      guild: { id: 'g' },
      plex: {},
      store: { save: noop, delete: noop },
      log: { info: noop, warn: noop, debug: noop },
      defaultVolume: 50,
      idleTimeoutMs: 60_000,
      onEnd: noop,
    } as unknown as SessionDeps);
    try {
      session.queue.add([entry]);
      await session.repostCard(channel);
    } finally {
      session.prepareShutdown();
    }

    expect(sent).toHaveLength(1);
    const flags = new MessageFlagsBitField(sent[0]?.flags as number);
    expect(flags.has(MessageFlags.SuppressNotifications)).toBe(true);
    expect(flags.has(MessageFlags.IsComponentsV2)).toBe(true);
  });
});
