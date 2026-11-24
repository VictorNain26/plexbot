import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import type { LoopMode, QueueEntry } from '../types.js';
import { escapeMarkdown, formatDuration, progressBar } from './format.js';

/** Brand colour of the bot (its icon's coral), used when Plex gives no cover colour. */
export const BRAND_COLOR = 0xff6b5a;
export const COVER_NAME = 'cover.jpg';

export const Buttons = {
  previous: 'pb:previous',
  toggle: 'pb:toggle',
  next: 'pb:next',
  shuffle: 'pb:shuffle',
  loop: 'pb:loop',
  stop: 'pb:stop',
  queue: 'pb:queue',
} as const;
export const QUEUE_PAGE_PREFIX = 'pb:queue-page:';

export interface NowPlayingView {
  readonly entry: QueueEntry;
  readonly elapsedMs: number;
  readonly paused: boolean;
  readonly loop: LoopMode;
  readonly volume: number;
  readonly upcoming: readonly QueueEntry[];
  readonly hasCover: boolean;
  readonly accentColor: number | undefined;
}

const LOOP_LABEL: Record<LoopMode, string> = {
  off: 'Boucle',
  track: 'Boucle : titre',
  queue: 'Boucle : file',
};
const UPCOMING_SHOWN = 3;

function line(entry: QueueEntry): string {
  return `${escapeMarkdown(entry.track.title)} — ${escapeMarkdown(entry.track.artist)}`;
}

/** The « now playing » card: Components V2 (container, section with the cover, buttons). */
export function nowPlayingCard(v: NowPlayingView) {
  const t = v.entry.track;
  const albumLine = [t.album && `*${escapeMarkdown(t.album)}*`, t.year].filter(Boolean).join(' · ');
  const header = new TextDisplayBuilder().setContent(
    [
      `### ${escapeMarkdown(t.title)}`,
      `**${escapeMarkdown(t.artist)}**${albumLine ? ` · ${albumLine}` : ''}`,
      `-# ${[t.library, `ajouté par ${escapeMarkdown(v.entry.requestedBy.name)}`].filter(Boolean).join(' · ')}`,
    ].join('\n'),
  );

  const status = [
    v.paused ? '⏸️ En pause' : '▶️ Lecture',
    v.loop === 'off' ? undefined : `🔁 ${LOOP_LABEL[v.loop]}`,
    `🔊 ${v.volume} %`,
  ].filter(Boolean);
  const progress = new TextDisplayBuilder().setContent(
    `\`${formatDuration(v.elapsedMs)}\` ${progressBar(v.elapsedMs, t.durationMs)} \`${formatDuration(t.durationMs)}\`\n-# ${status.join('  ·  ')}`,
  );

  const next = v.upcoming.slice(0, UPCOMING_SHOWN);
  const more = v.upcoming.length - next.length;
  const upcoming = new TextDisplayBuilder().setContent(
    next.length === 0
      ? '-# Rien après ce titre. Ajoute de la musique avec `/play`.'
      : [
          '**À suivre**',
          ...next.map((e, i) => `${i + 1}. ${line(e)}`),
          ...(more > 0 ? [`-# et ${more} autre${more > 1 ? 's' : ''}`] : []),
        ].join('\n'),
  );

  const section = new SectionBuilder().addTextDisplayComponents(header);
  if (v.hasCover) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(`attachment://${COVER_NAME}`)
        .setDescription(`Pochette de ${t.album || t.title}`),
    );
  }

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(Buttons.previous, '⏮️', 'Précédent'),
    button(Buttons.toggle, v.paused ? '▶️' : '⏸️', v.paused ? 'Reprendre' : 'Pause', ButtonStyle.Primary),
    button(Buttons.next, '⏭️', 'Suivant'),
    button(Buttons.shuffle, '🔀', 'Mélanger', ButtonStyle.Secondary, v.upcoming.length < 2),
    button(
      Buttons.loop,
      '🔁',
      LOOP_LABEL[v.loop],
      v.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success,
    ),
  );
  const secondary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(Buttons.queue, '📜', 'File d’attente'),
    button(Buttons.stop, '⏹️', 'Arrêter', ButtonStyle.Danger),
  );

  const container = new ContainerBuilder()
    .setAccentColor(v.accentColor ?? BRAND_COLOR)
    .addSectionComponents(section)
    .addTextDisplayComponents(progress)
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(upcoming)
    .addActionRowComponents(controls, secondary);

  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

/** What the card turns into once the queue is over. */
export function idleCard(reason: string) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND_COLOR)
    .addTextDisplayComponents((t) =>
      t.setContent(`### Plus rien à jouer\n-# ${reason} Relance avec \`/play\`.`),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

export const QUEUE_PAGE_SIZE = 10;

/** One page of the queue, numbered as `/retirer` and `/deplacer` expect. */
export function queueCard(current: QueueEntry | undefined, upcoming: readonly QueueEntry[], page: number) {
  const pages = Math.max(1, Math.ceil(upcoming.length / QUEUE_PAGE_SIZE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = upcoming.slice(p * QUEUE_PAGE_SIZE, (p + 1) * QUEUE_PAGE_SIZE);
  const totalMs = upcoming.reduce((sum, e) => sum + e.track.durationMs, 0);

  const body = [
    '### File d’attente',
    current ? `**En cours :** ${line(current)}` : '-# Rien en cours.',
    '',
    ...(slice.length === 0
      ? ['-# Aucun titre à suivre.']
      : slice.map(
          (e, i) =>
            `\`${String(p * QUEUE_PAGE_SIZE + i + 1).padStart(2, ' ')}\` ${line(e)} · ${formatDuration(e.track.durationMs)}`,
        )),
    '',
    `-# ${upcoming.length} titre${upcoming.length > 1 ? 's' : ''} · ${formatDuration(totalMs)} · page ${p + 1}/${pages}`,
  ].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(BRAND_COLOR)
    .addTextDisplayComponents((t) => t.setContent(body));
  if (pages > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`${QUEUE_PAGE_PREFIX}${p - 1}`, '◀️', 'Précédente', ButtonStyle.Secondary, p === 0),
        button(`${QUEUE_PAGE_PREFIX}${p + 1}`, '▶️', 'Suivante', ButtonStyle.Secondary, p >= pages - 1),
      ),
    );
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

function button(
  id: string,
  emoji: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
  disabled = false,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(id)
    .setEmoji(emoji)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}
