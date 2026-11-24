import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Interaction,
  MessageFlags,
  type SendableChannels,
} from 'discord.js';
import { GuildSession } from './audio/session.js';
import type { Logger } from './log.js';
import type { Library, PlexClient } from './plex/client.js';
import { type MediaRef, decodeRef, toChoices } from './plex/mapping.js';
import { shuffled } from './queue/queue.js';
import type { Store } from './store/store.js';
import type { LoopMode } from './types.js';
import { Buttons, QUEUE_PAGE_PREFIX, queueCard } from './ui/cards.js';
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

  async endAll(reason: string): Promise<void> {
    for (const s of this.#sessions.values()) s.save();
    await Promise.all([...this.#sessions.values()].map((s) => s.end(reason)));
  }

  async handle(i: Interaction): Promise<void> {
    if (!i.inCachedGuild() || i.guildId !== this.#d.guildId) {
      if (i.isRepliable())
        await i.reply({ content: 'Ce bot ne sert que sur son serveur.', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      if (i.isAutocomplete()) await this.#autocomplete(i);
      else if (i.isChatInputCommand()) await this.#command(i);
      else if (i.isButton()) await this.#button(i);
    } catch (err) {
      const message =
        err instanceof UserError
          ? err.message
          : 'Quelque chose a échoué de mon côté. Réessaie dans un instant.';
      if (!(err instanceof UserError)) this.#d.log.error({ err, interaction: i.id }, 'interaction failed');
      if (i.isRepliable()) {
        const reply = { content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral } as const;
        await (i.deferred || i.replied ? i.followUp(reply) : i.reply(reply)).catch(() => undefined);
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

    const s = this.#sessionFor(i.member, i.guild);
    switch (i.commandName) {
      case 'file':
        await i.reply({
          ...queueCard(s.queue.current, s.queue.upcoming, 0),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      case 'encours':
        await s.repostCard(this.#textChannel(i));
        await i.reply({ content: 'Carte remise en bas du salon.', flags: MessageFlags.Ephemeral });
        return;
      case 'passer': {
        const to = i.options.getInteger('jusqua');
        if (to === null) await s.skip();
        else await s.skipTo(this.#position(to, s));
        await i.reply({ content: '⏭️ Suivant.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'precedent':
        await s.previous();
        await i.reply({ content: '⏮️ Précédent.', flags: MessageFlags.Ephemeral });
        return;
      case 'pause': {
        const paused = await s.togglePause();
        await i.reply({
          content: paused ? '⏸️ En pause.' : '▶️ Reprise.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      case 'stop':
        await i.reply({ content: '⏹️ Musique arrêtée.', flags: MessageFlags.Ephemeral });
        await s.end(`Arrêtée par ${i.member.displayName}.`);
        return;
      case 'melanger':
        await s.shuffle();
        await i.reply({ content: '🔀 File mélangée.', flags: MessageFlags.Ephemeral });
        return;
      case 'boucle': {
        const mode = i.options.getString('mode', true) as LoopMode;
        await s.setLoop(mode);
        await i.reply({ content: '🔁 Boucle réglée.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'avancer': {
        const ms = parseDuration(i.options.getString('moment', true));
        if (ms === undefined) throw new UserError('Moment illisible : écris par exemple 1:30 ou 90.');
        await s.seek(ms);
        await i.reply({ content: '⏩ C’est parti.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'volume':
        await s.setVolume(i.options.getInteger('niveau', true));
        await i.reply({ content: `🔊 Volume à ${s.volume} %.`, flags: MessageFlags.Ephemeral });
        return;
      case 'retirer': {
        const position = this.#position(i.options.getInteger('position', true), s);
        let title = '';
        await s.edit((q) => {
          title = q.remove(position).track.title;
        });
        await i.reply({ content: `🗑️ Retiré : ${title}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      case 'deplacer': {
        const from = this.#position(i.options.getInteger('de', true), s);
        const to = this.#position(i.options.getInteger('vers', true), s);
        await s.edit((q) => {
          q.move(from, to);
        });
        await i.reply({ content: '↕️ Déplacé.', flags: MessageFlags.Ephemeral });
        return;
      }
      case 'vider':
        await s.edit((q) => {
          q.clearUpcoming();
        });
        await i.reply({ content: '🧹 File vidée.', flags: MessageFlags.Ephemeral });
        return;
      default:
        throw new UserError('Commande inconnue.');
    }
  }

  async #play(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const channel = i.member.voice.channel;
    if (!channel) throw new UserError('Rejoins d’abord un salon vocal.');
    const current = this.#sessions.get(i.guildId);
    if (
      current?.voiceChannelId &&
      current.voiceChannelId !== channel.id &&
      this.#listeners(current, i.guild) > 0
    ) {
      throw new UserError('Je joue déjà dans un autre salon vocal.');
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const ref = await this.#resolve(
      i.options.getString('recherche', true),
      i.options.getString('bibliotheque'),
    );
    let tracks = await this.#d.plex.tracks(ref);
    if (tracks.length === 0) throw new UserError('Rien à jouer là-dedans.');
    if (i.options.getBoolean('melanger') === true) tracks = shuffled(tracks);

    const s = this.session(i.guild);
    await s.join(channel, this.#textChannel(i));
    const next = i.options.getBoolean('ensuite') === true;
    await s.enqueue(tracks, { id: i.user.id, name: i.member.displayName }, { next });

    const what = tracks.length === 1 ? `**${tracks[0]?.title ?? ''}**` : `**${tracks.length} titres**`;
    await i.editReply(`✅ ${what} ${next ? 'jouera ensuite' : 'ajouté à la file'}.`);
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
