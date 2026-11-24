import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputStyle,
  ThumbnailBuilder,
} from 'discord.js';
import { type Choice, truncate } from '../plex/mapping.js';
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
  panelSearch: 'pb:panel-search',
  panelPlaylists: 'pb:panel-playlists',
  panelRandom: 'pb:panel-random',
} as const;
/** Select menus: jump to an upcoming entry, pick a search result or a playlist. */
export const Selects = { jump: 'pb:jump', pick: 'pb:pick' } as const;
export const SEARCH_MODAL = 'pb:search-modal';
export const SEARCH_FIELD = 'query';
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
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [controls, secondary];
  const jump = jumpMenu(v.upcoming);
  if (jump) rows.unshift(jump);

  const container = new ContainerBuilder().setAccentColor(v.accentColor ?? BRAND_COLOR);
  // A section needs an accessory (Components V2): with no cover, the header stands alone.
  if (v.hasCover) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(header)
        .setThumbnailAccessory(
          new ThumbnailBuilder()
            .setURL(`attachment://${COVER_NAME}`)
            .setDescription(`Pochette de ${t.album || t.title}`),
        ),
    );
  } else {
    container.addTextDisplayComponents(header);
  }
  container
    .addTextDisplayComponents(progress)
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(upcoming)
    .addActionRowComponents(...rows);
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

/** A short notice, for a reply that replaces a Components V2 message (a picker). */
export function noticeCard(text: string) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND_COLOR)
    .addTextDisplayComponents((t) => t.setContent(text));
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

/** Discord shows at most 25 options in a select menu, each label and value at most 100 characters. */
export const SELECT_MAX = 25;

/** « Aller à… »: the next entries, by their uid so a reordered queue can't jump to the wrong one. */
function jumpMenu(upcoming: readonly QueueEntry[]) {
  if (upcoming.length === 0) return undefined;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(Selects.jump)
    .setPlaceholder('Aller à…')
    .addOptions(
      upcoming.slice(0, SELECT_MAX).map((e, i) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${i + 1}. ${e.track.title}`, 100))
          .setValue(e.uid);
        // A description must not be empty (discord.js builders).
        if (e.track.artist) option.setDescription(truncate(e.track.artist, 100));
        return option;
      }),
    );
  return new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(menu);
}

/** The jukebox panel: everything without typing a command. */
export function panelCard() {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND_COLOR)
    .addTextDisplayComponents((t) =>
      t.setContent(
        '### 🎶 Jukebox Plex\nRejoins un salon vocal, puis choisis : chercher une piste, un album ou une playlist, ' +
          'lancer une de tes playlists, ou laisser faire le hasard.',
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(Buttons.panelSearch, '🔍', 'Chercher', ButtonStyle.Primary),
        button(Buttons.panelPlaylists, '📜', 'Playlists'),
        button(Buttons.panelRandom, '🎲', 'Au hasard'),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

/** The search box the « Chercher » button opens. */
export function searchModal() {
  return new ModalBuilder()
    .setCustomId(SEARCH_MODAL)
    .setTitle('Chercher dans Plex')
    .addLabelComponents((l) =>
      l
        .setLabel('Titre, album ou playlist')
        .setTextInputComponent((t) =>
          t
            .setCustomId(SEARCH_FIELD)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(2)
            .setMaxLength(100),
        ),
    );
}

/** A menu of choices (search results, playlists) that plays the one picked. */
export function pickerCard(title: string, choices: readonly Choice[]) {
  const container = new ContainerBuilder().setAccentColor(BRAND_COLOR);
  if (choices.length === 0) {
    container.addTextDisplayComponents((t) => t.setContent(`### ${title}\n-# Rien trouvé.`));
  } else {
    container
      .addTextDisplayComponents((t) => t.setContent(`### ${title}`))
      .addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(Selects.pick)
            .setPlaceholder('Choisis ce qui doit jouer')
            .addOptions(
              choices
                .slice(0, SELECT_MAX)
                .map((c) =>
                  new StringSelectMenuOptionBuilder().setLabel(truncate(c.name, 100)).setValue(c.value),
                ),
            ),
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
