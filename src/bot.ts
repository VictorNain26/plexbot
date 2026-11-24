import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  MessageFlags,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { GuildSession } from './audio/session.js';
import type { Logger } from './log.js';
import type { Library, PlexClient } from './plex/client.js';
import { type MediaRef, decodeRef, toChoices } from './plex/mapping.js';
import { shuffled } from './queue/queue.js';
import type { Store } from './store/store.js';
import type { LoopMode, Track } from './types.js';
import {
  Buttons,
  QUEUE_PAGE_PREFIX,
  SEARCH_FIELD,
  SEARCH_MODAL,
  Selects,
  panelCard,
  pickerCard,
  queueCard,
  searchModal,
} from './ui/cards.js';
import { parseDuration } from './ui/format.js';

export interface BotDeps {
  readonly client: Client;
  readonly plex: PlexClient;
  readonly store: Store;
  readonly log: Logger;
  readonly guildId: string;
  readonly libraries: readonly Library[];
  readonly defaultVolume: number;
  readonly idleTimeoutMs: number;
}

/** Tracks the « Au hasard » button queues. */
const RANDOM_COUNT = 20;

/** Interactions that can start playback (they carry the member and their channel). */
type Playing =
  | ChatInputCommandInteraction<'cached'>
  | ButtonInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>
  | AutocompleteInteraction<'cached'>;

/** A message for the user who acted, shown only to them. */
class UserError extends Error {}

/** Routes interactions to the guild's playback session; one session per guild. */
export class Bot {
  readonly #d: BotDeps;
  readonly #sessions = new Map<string, GuildSession>();

  constructor(deps: BotDeps) {
    this.#d = deps;
  }

  session(guild: Guild): GuildSession {
    let s = this.#sessions.get(guild.id);
    if (!s) {
      s = new GuildSession({
        guild,
        plex: this.#d.plex,
        store: this.#d.store,
        log: this.#d.log.child({ guild: guild.id }),
        defaultVolume: this.#d.defaultVolume,
        idleTimeoutMs: this.#d.idleTimeoutMs,
        onEnd: () => this.#sessions.delete(guild.id),
      });
      this.#sessions.set(guild.id, s);
    }
    return s;
  }

  existing(guildId: string): GuildSession | undefined {
    return this.#sessions.get(guildId);
  }

  /** Saves every session for the restart and keeps them from deleting themselves. */
  prepareShutdown(): void {
    for (const s of this.#sessions.values()) s.prepareShutdown();
  }

  async handle(i: Interaction): Promise<void> {
    try {
      if (!i.inCachedGuild() || i.guildId !== this.#d.guildId) {
        if (i.isRepliable()) throw new UserError('Ce bot ne sert que sur son serveur.');
        return;
      }
      if (i.isAutocomplete()) await this.#autocomplete(i);
      else if (i.isChatInputCommand()) await this.#command(i);
      else if (i.isButton()) await this.#button(i);
      else if (i.isStringSelectMenu()) await this.#select(i);
      else if (i.isModalSubmit()) await this.#modal(i);
    } catch (err) {
      const message =
        err instanceof UserError
          ? err.message
          : 'Quelque chose a échoué de mon côté. Réessaie dans un instant.';
      if (!(err instanceof UserError)) this.#d.log.error({ err, interaction: i.id }, 'interaction failed');
      if (i.isRepliable()) {
        const reply = { content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral } as const;
        await (
          i.deferred ? i.editReply(`⚠️ ${message}`) : i.replied ? i.followUp(reply) : i.reply(reply)
        ).catch(() => undefined);
      }
    }
  }

  async #autocomplete(i: AutocompleteInteraction<'cached'>): Promise<void> {
    const query = i.options.getFocused().trim();
    const library = i.options.getString('bibliotheque');
    const sectionId = library === null ? undefined : Number(library);
    try {
      const items = query.length < 2 ? await this.#d.plex.audioPlaylists() : await this.#d.plex.search(query);
      await i.respond(toChoices(items, { sectionId }));
    } catch (err) {
      this.#d.log.warn({ err: (err as Error).message }, 'autocomplete failed');
      await i.respond([]).catch(() => undefined);
    }
  }

  async #command(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    if (i.commandName === 'play') return this.#play(i);
    if (i.commandName === 'panneau') {
      const channel = this.#textChannel(i);
      await channel.send(panelCard());
      await i.reply({ content: 'Panneau jukebox publié.', flags: MessageFlags.Ephemeral });
      return;
    }

    const s = this.#sessionFor(i.member, i.guild);
    if (i.commandName !== 'file') {
      // Discord drops an interaction not answered within 3 s; Plex calls can take longer.
      await i.deferReply({ flags: MessageFlags.Ephemeral });
    }
    switch (i.commandName) {
      case 'file':
        await i.reply({
          ...queueCard(s.queue.current, s.queue.upcoming, 0),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      case 'encours':
        await s.repostCard(this.#textChannel(i));
        await i.editReply('Carte remise en bas du salon.');
        return;
      case 'passer': {
        const to = i.options.getInteger('jusqua');
        if (to === null) await s.skip();
        else await s.skipTo(this.#position(to, s));
        await i.editReply('⏭️ Suivant.');
        return;
      }
      case 'precedent':
        await s.previous();
        await i.editReply('⏮️ Précédent.');
        return;
      case 'pause': {
        const paused = await s.togglePause();
        await i.editReply(paused ? '⏸️ En pause.' : '▶️ Reprise.');
        return;
      }
      case 'stop':
        await i.editReply('⏹️ Musique arrêtée.');
        await s.end(`Arrêtée par ${i.member.displayName}.`);
        return;
      case 'melanger':
        await s.shuffle();
        await i.editReply('🔀 File mélangée.');
        return;
      case 'boucle': {
        const mode = i.options.getString('mode', true) as LoopMode;
        await s.setLoop(mode);
        await i.editReply('🔁 Boucle réglée.');
        return;
      }
      case 'avancer': {
        const ms = parseDuration(i.options.getString('moment', true));
        if (ms === undefined) throw new UserError('Moment illisible : écris par exemple 1:30 ou 90.');
        await s.seek(ms);
        await i.editReply('⏩ C’est parti.');
        return;
      }
      case 'volume':
        await s.setVolume(i.options.getInteger('niveau', true));
        await i.editReply(`🔊 Volume à ${s.volume} %.`);
        return;
      case 'retirer': {
        const position = this.#position(i.options.getInteger('position', true), s);
        let title = '';
        await s.edit((q) => {
          title = q.remove(position).track.title;
        });
        await i.editReply(`🗑️ Retiré : ${title}.`);
        return;
      }
      case 'deplacer': {
        const from = this.#position(i.options.getInteger('de', true), s);
        const to = this.#position(i.options.getInteger('vers', true), s);
        await s.edit((q) => {
          q.move(from, to);
        });
        await i.editReply('↕️ Déplacé.');
        return;
      }
      case 'vider':
        await s.edit((q) => {
          q.clearUpcoming();
        });
        await i.editReply('🧹 File vidée.');
        return;
      default:
        throw new UserError('Commande inconnue.');
    }
  }

  async #play(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    this.#voiceChannelOf(i.member, i.guild);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const ref = await this.#resolve(
      i.options.getString('recherche', true),
      i.options.getString('bibliotheque'),
    );
    await this.#start(i, await this.#d.plex.tracks(ref), {
      next: i.options.getBoolean('ensuite') === true,
      shuffle: i.options.getBoolean('melanger') === true,
    });
  }

  /** The member's voice channel, when the bot may play there. */
  #voiceChannelOf(member: GuildMember, guild: Guild): VoiceBasedChannel {
    const channel = member.voice.channel;
    if (!channel) throw new UserError('Rejoins d’abord un salon vocal.');
    const current = this.#sessions.get(guild.id);
    if (
      current?.voiceChannelId &&
      current.voiceChannelId !== channel.id &&
      this.#listeners(current, guild) > 0
    ) {
      throw new UserError('Je joue déjà dans un autre salon vocal.');
    }
    return channel;
  }

  /**
   * Joins the member's voice channel and queues `tracks`; the interaction was deferred (ephemeral)
   * and gets the confirmation. Shared by /play, the panel and its menus.
   */
  async #start(
    i: Exclude<Playing, AutocompleteInteraction>,
    found: readonly Track[],
    options: { next?: boolean; shuffle?: boolean } = {},
  ): Promise<void> {
    const channel = this.#voiceChannelOf(i.member, i.guild);
    if (found.length === 0) throw new UserError('Rien à jouer là-dedans.');
    const tracks = options.shuffle === true ? shuffled(found) : found;
    const text = i.channel;
    if (!text?.isSendable()) throw new UserError('Lance la musique depuis un salon où je peux écrire.');
    const s = this.session(i.guild);
    await s.join(channel, text);
    await s.enqueue(tracks, { id: i.user.id, name: i.member.displayName }, { next: options.next === true });
    const what = tracks.length === 1 ? `**${tracks[0]?.title ?? ''}**` : `**${tracks.length} titres**`;
    await i.editReply({
      content: `✅ ${what} ${options.next === true ? 'jouera ensuite' : 'ajouté à la file'}.`,
      components: [],
    });
  }

  /** The option value from the autocomplete, or, for typed text, the first search result. */
  async #resolve(value: string, library: string | null): Promise<MediaRef> {
    const ref = decodeRef(value);
    if (ref) return ref;
    const sectionId = library === null ? undefined : Number(library);
    const [first] = toChoices(await this.#d.plex.search(value), { sectionId, limit: 1 });
    const found = first && decodeRef(first.value);
    if (!found) throw new UserError(`Rien trouvé pour « ${value} ».`);
    return found;
  }

  async #button(i: ButtonInteraction<'cached'>): Promise<void> {
    if (i.customId.startsWith(QUEUE_PAGE_PREFIX)) {
      const s = this.#sessions.get(i.guildId);
      const page = Number(i.customId.slice(QUEUE_PAGE_PREFIX.length));
      await i.update(queueCard(s?.queue.current, s?.queue.upcoming ?? [], Number.isInteger(page) ? page : 0));
      return;
    }
    switch (i.customId) {
      case Buttons.panelSearch:
        await i.showModal(searchModal());
        return;
      case Buttons.panelPlaylists: {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const playlists = toChoices(await this.#d.plex.audioPlaylists());
        await i.editReply({
          ...pickerCard('📜 Tes playlists', playlists),
          flags: MessageFlags.IsComponentsV2,
        });
        return;
      }
      case Buttons.panelRandom:
        this.#voiceChannelOf(i.member, i.guild);
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await this.#start(i, await this.#d.plex.randomTracks(RANDOM_COUNT));
        return;
    }
    const s = this.#sessionFor(i.member, i.guild);
    switch (i.customId) {
      case Buttons.previous:
        await i.deferUpdate();
        return s.previous();
      case Buttons.toggle:
        await i.deferUpdate();
        await s.togglePause();
        return;
      case Buttons.next:
        await i.deferUpdate();
        return s.skip();
      case Buttons.shuffle:
        await i.deferUpdate();
        return s.shuffle();
      case Buttons.loop:
        await i.deferUpdate();
        await s.cycleLoop();
        return;
      case Buttons.stop:
        await i.deferUpdate();
        return s.end(`Arrêtée par ${i.member.displayName}.`);
      case Buttons.queue:
        await i.reply({
          ...queueCard(s.queue.current, s.queue.upcoming, 0),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      default:
        throw new UserError('Ce bouton n’est plus valable.');
    }
  }

  async #select(i: StringSelectMenuInteraction<'cached'>): Promise<void> {
    const [value] = i.values;
    if (value === undefined) return;
    if (i.customId === Selects.jump) {
      const s = this.#sessionFor(i.member, i.guild);
      await i.deferUpdate();
      await s.jumpTo(value);
      return;
    }
    if (i.customId === Selects.pick) {
      const ref = decodeRef(value);
      if (!ref) throw new UserError('Ce choix n’est plus valable.');
      this.#voiceChannelOf(i.member, i.guild);
      // The menu is in an ephemeral message: its own reply becomes the confirmation.
      await i.deferUpdate();
      await this.#start(i, await this.#d.plex.tracks(ref));
      return;
    }
    throw new UserError('Ce menu n’est plus valable.');
  }

  async #modal(i: ModalSubmitInteraction<'cached'>): Promise<void> {
    if (i.customId !== SEARCH_MODAL) throw new UserError('Cette fenêtre n’est plus valable.');
    const query = i.fields.getTextInputValue(SEARCH_FIELD).trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const choices = toChoices(await this.#d.plex.search(query));
    await i.editReply({ ...pickerCard(`🔍 « ${query} »`, choices), flags: MessageFlags.IsComponentsV2 });
  }

  /** The session a member may control: the bot plays, and they are in its voice channel. */
  #sessionFor(member: GuildMember, guild: Guild): GuildSession {
    const s = this.#sessions.get(guild.id);
    if (!s?.voiceChannelId || s.queue.current === undefined)
      throw new UserError('Rien ne joue en ce moment.');
    if (member.voice.channelId !== s.voiceChannelId)
      throw new UserError('Rejoins le salon vocal du bot pour le piloter.');
    return s;
  }

  #position(position: number, s: GuildSession): number {
    const n = s.queue.upcoming.length;
    if (position > n)
      throw new UserError(n === 0 ? 'Aucun titre à suivre.' : `Choisis une position entre 1 et ${n}.`);
    return position;
  }

  #textChannel(i: ChatInputCommandInteraction<'cached'>): SendableChannels {
    if (!i.channel?.isSendable()) throw new UserError('Lance la commande depuis un salon où je peux écrire.');
    return i.channel;
  }

  /** People (not bots) in the session's voice channel. */
  #listeners(s: GuildSession, guild: Guild): number {
    const channel = s.voiceChannelId ? guild.channels.cache.get(s.voiceChannelId) : undefined;
    return channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;
  }

  /** Starts or cancels the idle timer as people come and go in the bot's channel. */
  onVoiceChange(guild: Guild): void {
    const s = this.#sessions.get(guild.id);
    if (!s?.voiceChannelId) return;
    if (this.#listeners(s, guild) === 0) s.startIdleTimer('Plus personne dans le salon vocal.');
    else if (s.queue.current !== undefined) s.cancelIdleTimer();
  }
}
