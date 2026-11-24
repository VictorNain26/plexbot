import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import type { QueueEntry } from '../src/types.js';
import {
  BRAND_COLOR,
  Buttons,
  idleCard,
  nowPlayingCard,
  QUEUE_PAGE_PREFIX,
  queueCard,
} from '../src/ui/cards.js';

const entry = (n: number): QueueEntry => ({
  uid: `u${n}`,
  track: {
    id: String(100 + n),
    title: `Titre ${n}`,
    artist: 'Artiste',
    album: 'Album',
    year: 2003,
    durationMs: 200_000,
    thumb: '/library/metadata/1/thumb/2',
    library: 'Musique',
  },
  requestedBy: { id: '1', name: 'Victor' },
});

/** Every text and button of a Components V2 payload, flattened. */
function flatten(payload: { components: { toJSON(): unknown }[] }) {
  const texts: string[] = [];
  const buttons: { custom_id: string; style: number; disabled?: boolean; label?: string }[] = [];
  let accent: number | undefined;
  const walk = (c: unknown): void => {
    if (typeof c !== 'object' || c === null) return;
    const o = c as Record<string, unknown>;
    if (o.type === ComponentType.Container) accent = o.accent_color as number;
    if (o.type === ComponentType.TextDisplay) texts.push(o.content as string);
    if (o.type === ComponentType.Button) buttons.push(o as never);
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  payload.components.forEach((c) => {
    walk(c.toJSON());
  });
  return { text: texts.join('\n'), buttons, accent };
}

describe('now playing card', () => {
  const base = {
    entry: entry(0),
    elapsedMs: 100_000,
    paused: false,
    loop: 'off' as const,
    volume: 80,
    upcoming: [entry(1), entry(2), entry(3), entry(4)],
    hasCover: true,
    accentColor: 0x123456,
  };

  it('shows the track, its library, the progress and what comes next', () => {
    const card = nowPlayingCard(base);
    expect(card.flags).toBe(MessageFlags.IsComponentsV2);
    const { text, accent } = flatten(card);
    expect(text).toContain('### Titre 0');
    expect(text).toContain('Musique · ajouté par Victor');
    expect(text).toContain('`1:40` ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱ `3:20`');
    expect(text).toContain('1. Titre 1 — Artiste');
    expect(text).toContain('et 1 autre');
    expect(accent).toBe(0x123456);
  });

  it('offers every control, and reflects pause and loop', () => {
    const { buttons } = flatten(nowPlayingCard({ ...base, paused: true, loop: 'queue' }));
    expect(buttons.map((b) => b.custom_id)).toEqual([
      Buttons.previous,
      Buttons.toggle,
      Buttons.next,
      Buttons.shuffle,
      Buttons.loop,
      Buttons.queue,
      Buttons.stop,
    ]);
    expect(buttons.find((b) => b.custom_id === Buttons.toggle)?.label).toBe('Reprendre');
    expect(buttons.find((b) => b.custom_id === Buttons.loop)?.style).toBe(ButtonStyle.Success);
  });

  it('disables shuffle with fewer than two tracks to come, and falls back to the brand colour', () => {
    const card = flatten(nowPlayingCard({ ...base, upcoming: [entry(1)], accentColor: undefined }));
    expect(card.buttons.find((b) => b.custom_id === Buttons.shuffle)?.disabled).toBe(true);
    expect(card.accent).toBe(BRAND_COLOR);
  });

  it('escapes markdown in titles', () => {
    const odd = { ...entry(0), track: { ...entry(0).track, title: '*NSYNC_' } };
    expect(flatten(nowPlayingCard({ ...base, entry: odd })).text).toContain('\\*NSYNC\\_');
  });

  it('tells the queue is over on the idle card', () => {
    expect(flatten(idleCard('La file est terminée.')).text).toContain('Plus rien à jouer');
  });
});

describe('queue card', () => {
  const upcoming = Array.from({ length: 23 }, (_, i) => entry(i + 1));

  it('numbers entries as /retirer expects and pages them by ten', () => {
    const { text, buttons } = flatten(queueCard(entry(0), upcoming, 1));
    expect(text).toContain('`11` Titre 11 — Artiste');
    expect(text).toContain('page 2/3');
    expect(buttons.map((b) => b.custom_id)).toEqual([`${QUEUE_PAGE_PREFIX}0`, `${QUEUE_PAGE_PREFIX}2`]);
  });

  it('clamps an out-of-range page and hides paging for one page', () => {
    expect(flatten(queueCard(entry(0), upcoming, 99)).text).toContain('page 3/3');
    expect(flatten(queueCard(undefined, [], 0)).buttons).toEqual([]);
  });
});

describe('Store', () => {
  it('saves, loads and deletes a session', () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'plexbot-')));
    const session = {
      voiceChannelId: 'v',
      textChannelId: 't',
      items: [entry(0), { ...entry(1), track: { ...entry(1).track, year: undefined, thumb: undefined } }],
      index: 1,
      loop: 'queue' as const,
      volume: 70,
      positionMs: 12_000,
      paused: true,
    };
    store.save('g', session);
    expect(store.load('g')).toEqual(session);
    store.delete('g');
    expect(store.load('g')).toBeUndefined();
    store.close();
  });
});

describe('loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plexbot-cfg-'));
  writeFileSync(join(dir, 'discord'), 'discord-secret\n');
  writeFileSync(join(dir, 'plex'), 'plex-secret');
  writeFileSync(join(dir, 'empty'), '  \n');
  const env = {
    DISCORD_GUILD_ID: '1383891124481163485',
    PLEX_URL: 'http://172.30.0.1:32400',
    DISCORD_TOKEN_FILE: join(dir, 'discord'),
    PLEX_TOKEN_FILE: join(dir, 'plex'),
  };

  it('reads the secrets from files and applies defaults', () => {
    const c = loadConfig(env);
    expect(c.discordToken).toBe('discord-secret');
    expect(c.plex.token).toBe('plex-secret');
    expect(c.defaultVolume).toBe(80);
  });

  it('names a wrong setting without printing any secret', () => {
    expect(() => loadConfig({ ...env, DISCORD_GUILD_ID: 'abc' })).toThrow(/DISCORD_GUILD_ID/);
    expect(() => loadConfig({ ...env, PLEX_TOKEN_FILE: join(dir, 'empty') })).toThrow(/is empty/);
    expect(() => loadConfig({ ...env, PLEX_TOKEN_FILE: join(dir, 'missing') })).toThrow(/ENOENT/);
    try {
      loadConfig({ ...env, DEFAULT_VOLUME: '500' });
    } catch (err) {
      expect(String(err)).not.toContain('secret');
    }
  });
});
