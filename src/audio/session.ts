import { randomUUID } from 'node:crypto';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  AttachmentBuilder,
  type Guild,
  type Message,
  MessageFlags,
  type SendableChannels,
  type VoiceBasedChannel,
} from 'discord.js';
import type { Logger } from '../log.js';
import type { PlexClient } from '../plex/client.js';
import { Queue } from '../queue/queue.js';
import type { SavedSession, Store } from '../store/store.js';
import type { LoopMode, QueueEntry, Requester, Track } from '../types.js';
import { COVER_NAME, idleCard, nowPlayingCard } from '../ui/cards.js';
import { type Ffmpeg, startFfmpeg } from './stream.js';

export interface SessionDeps {
  readonly guild: Guild;
  readonly plex: PlexClient;
  readonly store: Store;
  readonly log: Logger;
  readonly defaultVolume: number;
  readonly idleTimeoutMs: number;
  /** Called once the session is over (left the channel), so the registry can forget it. */
  readonly onEnd: () => void;
}

const CARD_REFRESH_MS = 15_000;
const TIMELINE_MS = 10_000;
const SAVE_MS = 15_000;
/** Plex marks a track played past 90 % (its default « watched » threshold for music too). */
const SCROBBLE_RATIO = 0.9;
const MAX_CONSECUTIVE_FAILURES = 5;

interface Cover {
  readonly jpeg: Buffer | undefined;
  readonly accent: number | undefined;
}

/**
 * Playback for one guild: the voice connection, the audio player, the queue and its card.
 * Discord.js voice patterns follow the discord.js guide (voice connections, life cycle).
 */
export class GuildSession {
  readonly queue = new Queue<QueueEntry>();
  readonly #d: SessionDeps;
  readonly #player: AudioPlayer;
  #connection: VoiceConnection | undefined;
  #textChannel: SendableChannels | undefined;
  #resource: AudioResource | undefined;
  #ffmpeg: { process: Ffmpeg; stderr: () => string } | undefined;
  #offsetMs = 0;
  #volume: number;
  /** The voice channel's bitrate: ffmpeg encodes Opus at it (capped at 128 kb/s, stream.ts). */
  #bitrate: number | undefined;
  #card: Message | undefined;
  #covers = new Map<string, Cover>();
  #timers: NodeJS.Timeout[] = [];
  #idleTimer: NodeJS.Timeout | undefined;
  #scrobbled = false;
  #failures = 0;
  /** Set while the bot itself stops the player (stop() emits Idle synchronously), so that Idle is not read as « track ended ». */
  #stopping = false;
  #ended = false;
  /** Set by a shutdown: the session is saved for the restart, so nothing may end or delete it. */
  #shuttingDown = false;
  /** What the users asked for. A pause asked while the stream still buffers applies once it plays. */
  #wantPaused = false;
  /**
   * Where the stream restarts once unpaused. A volume change or a seek made while paused waits
   * here: restarting the stream right away would send its first packets before it is paused again.
   */
  #pendingStartMs: number | undefined;
  /** Each #play call takes a number; one that finishes after a newer one is dropped. */
  #playGeneration = 0;

  constructor(deps: SessionDeps) {
    this.#d = deps;
    this.#volume = deps.defaultVolume;
    this.#player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.#player.on(AudioPlayerStatus.Idle, () => void this.#onIdle());
    this.#player.on(AudioPlayerStatus.Playing, () => {
      if (this.#wantPaused) this.#player.pause();
    });
    // A packet not ready when the 20 ms send timer fires goes out as silence: an audible gap
    // (@discordjs/voice AudioPlayer). Each stream's count is logged when it ends.
    this.#player.on('stateChange', (before, after) => {
      if (before.status === AudioPlayerStatus.Playing && after.status !== AudioPlayerStatus.Playing) {
        const missed = before.missedFrames;
        if (missed > 0) this.#d.log.warn({ missedFrames: missed }, 'frames went out as silence');
      }
    });
    this.#player.on('error', (err) => {
      this.#d.log.warn({ err: err.message, track: this.queue.current?.track.id }, 'audio player error');
    });
    this.#timers.push(
      setInterval(() => {
        void this.#refreshCard();
      }, CARD_REFRESH_MS),
      setInterval(() => {
        void this.#reportTimeline('playing');
      }, TIMELINE_MS),
      setInterval(() => {
        this.save();
      }, SAVE_MS),
    );
  }

  get voiceChannelId(): string | undefined {
    return this.#connection?.joinConfig.channelId ?? undefined;
  }

  get paused(): boolean {
    return this.#wantPaused;
  }

  get volume(): number {
    return this.#volume;
  }

  get positionMs(): number {
    if (this.#pendingStartMs !== undefined) return this.#pendingStartMs;
    return this.#offsetMs + (this.#resource?.playbackDuration ?? 0);
  }

  /** Joins (or moves to) a voice channel and waits until the connection is ready. */
  async join(channel: VoiceBasedChannel, textChannel: SendableChannels): Promise<void> {
    this.#textChannel = textChannel;
    this.#bitrate = channel.bitrate;
    const current = this.#connection;
    if (
      current?.joinConfig.channelId === channel.id &&
      current.state.status === VoiceConnectionStatus.Ready
    ) {
      return;
    }
    // joinVoiceChannel moves the guild's existing connection rather than opening a second one.
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    if (connection !== current) this.#watch(connection);
    this.#connection = connection;
    connection.subscribe(this.#player);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      // As the discord.js guide does: a connection that never got ready is destroyed.
      this.#connection = undefined;
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw err;
    }
  }

  /** Reconnects after a short drop, and ends the session once the connection is gone. */
  #watch(connection: VoiceConnection): void {
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Moved or briefly dropped: it reconnects by itself within 5 s, otherwise it is gone.
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.#connection === connection && !this.#shuttingDown) void this.end('Déconnecté du salon vocal.');
    });
  }

  /** Adds tracks; starts playing if nothing was. */
  async enqueue(
    tracks: readonly Track[],
    requestedBy: Requester,
    options: { next?: boolean } = {},
  ): Promise<void> {
    const wasIdle = this.queue.current === undefined;
    if (wasIdle) this.#wantPaused = false;
    this.queue.add(
      tracks.map((track) => ({ uid: randomUUID(), track, requestedBy })),
      options,
    );
    this.#cancelIdle();
    if (wasIdle) await this.#play();
    else await this.#refreshCard();
    this.save();
  }

  async togglePause(): Promise<boolean> {
    this.#wantPaused = !this.#wantPaused;
    const pending = this.#pendingStartMs;
    if (this.#wantPaused) this.#player.pause();
    else if (pending !== undefined) await this.#play(pending, { keepCard: true, keepOnError: true });
    else this.#player.unpause();
    await this.#reportTimeline(this.paused ? 'paused' : 'playing');
    await this.#refreshCard();
    return this.paused;
  }

  async skip(): Promise<void> {
    await this.#reportTimeline('stopped');
    this.#wantPaused = false;
    this.queue.advance('skip');
    await this.#playOrFinish();
  }

  async skipTo(position: number): Promise<void> {
    await this.#reportTimeline('stopped');
    this.#wantPaused = false;
    this.queue.skipTo(position);
    await this.#play();
  }

  async previous(): Promise<void> {
    await this.#reportTimeline('stopped');
    // Within the first seconds of a track, « previous » goes back a track; later, to its start.
    if (this.positionMs < 5_000) this.queue.previous();
    this.#wantPaused = false;
    await this.#play();
  }

  async seek(ms: number): Promise<void> {
    const current = this.queue.current;
    if (!current) return;
    const at = Math.min(Math.max(ms, 0), Math.max(current.track.durationMs - 1_000, 0));
    await this.#restartAt(at);
  }

  async setVolume(percent: number): Promise<void> {
    this.#volume = Math.min(Math.max(Math.round(percent), 0), 150);
    // ffmpeg applies the volume: the stream restarts at the same position with the new one.
    if (this.queue.current && (this.#resource || this.#pendingStartMs !== undefined)) {
      await this.#restartAt(this.positionMs);
    } else {
      await this.#refreshCard();
    }
    this.save();
  }

  /**
   * Restarts the current track at `ms` (volume, seek). While paused, it only records where to
   * restart; a Plex error keeps the current stream rather than skipping the track.
   */
  async #restartAt(ms: number): Promise<void> {
    if (this.#wantPaused) {
      this.#pendingStartMs = ms;
      await this.#refreshCard();
      return;
    }
    await this.#play(ms, { keepCard: true, keepOnError: true });
  }

  /** Jumps to an upcoming entry by its uid (the « Aller à… » menu); gone entries are ignored. */
  async jumpTo(uid: string): Promise<void> {
    const position = this.queue.upcoming.findIndex((e) => e.uid === uid) + 1;
    if (position > 0) await this.skipTo(position);
  }

  async setLoop(mode: LoopMode): Promise<void> {
    this.queue.loop = mode;
    await this.#refreshCard();
    this.save();
  }

  async cycleLoop(): Promise<LoopMode> {
    const next: Record<LoopMode, LoopMode> = { off: 'queue', queue: 'track', track: 'off' };
    await this.setLoop(next[this.queue.loop]);
    return this.queue.loop;
  }

  async shuffle(): Promise<void> {
    this.queue.shuffle();
    await this.#refreshCard();
    this.save();
  }

  async edit(change: (q: Queue<QueueEntry>) => void): Promise<void> {
    change(this.queue);
    await this.#refreshCard();
    this.save();
  }

  /** Puts the « now playing » card at the bottom of the text channel again. */
  async repostCard(textChannel: SendableChannels): Promise<void> {
    this.#textChannel = textChannel;
    await this.#sendCard();
  }

  /**
   * Before the process stops: saves the session and stops reacting to the voice connection
   * closing, so the restart finds the queue (end() would delete it).
   */
  prepareShutdown(): void {
    this.save();
    this.#shuttingDown = true;
    for (const t of this.#timers) clearInterval(t);
    this.#cancelIdle();
  }

  /** Stops everything, leaves the channel and forgets the queue. */
  async end(reason: string): Promise<void> {
    if (this.#ended || this.#shuttingDown) return;
    this.#ended = true;
    await this.#reportTimeline('stopped');
    for (const t of this.#timers) clearInterval(t);
    this.#cancelIdle();
    this.#stopSilently();
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    this.queue.reset();
    this.#d.store.delete(this.#d.guild.id);
    await this.#card?.edit(idleCard(reason)).catch(() => undefined);
    this.#d.log.info({ reason }, 'session ended');
    this.#d.onEnd();
  }

  /** Leaves after the idle timeout unless something plays again (alone in the channel, queue over). */
  startIdleTimer(reason: string): void {
    if (this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => void this.end(reason), this.#d.idleTimeoutMs);
  }

  cancelIdleTimer(): void {
    this.#cancelIdle();
  }

  snapshot(): SavedSession | undefined {
    const channelId = this.voiceChannelId;
    if (!channelId || !this.#textChannel || this.queue.current === undefined) return undefined;
    const q = this.queue.snapshot();
    return {
      voiceChannelId: channelId,
      textChannelId: this.#textChannel.id,
      items: q.items,
      index: q.index,
      loop: q.loop,
      volume: this.#volume,
      positionMs: this.positionMs,
      paused: this.paused,
      cardMessageId: this.#card?.id,
    };
  }

  save(): void {
    if (this.#ended) return;
    const s = this.snapshot();
    if (s) this.#d.store.save(this.#d.guild.id, s);
  }

  /** Picks a saved session back up: same queue, same track, same position. */
  async restore(
    saved: SavedSession,
    channel: VoiceBasedChannel,
    textChannel: SendableChannels,
  ): Promise<void> {
    this.queue.replace({ items: saved.items, index: saved.index, loop: saved.loop });
    this.#volume = saved.volume;
    this.#wantPaused = saved.paused;
    // The card of the previous run still shows its buttons: it goes, a fresh one replaces it.
    if (saved.cardMessageId) {
      await textChannel.messages.delete(saved.cardMessageId).catch((err: unknown) => {
        this.#d.log.debug({ err: (err as Error).message }, 'old card already gone');
      });
    }
    await this.join(channel, textChannel);
    if (saved.paused) {
      // Nothing streams until « reprendre »: the card shows where it will resume.
      this.#pendingStartMs = saved.positionMs;
      await this.#sendCard();
    } else {
      await this.#play(saved.positionMs);
    }
  }

  async #onIdle(): Promise<void> {
    if (this.#stopping) return;
    const finished = this.queue.current;
    if (finished) {
      const playedMs = this.positionMs;
      // An « ended » that came after a few hundred ms is a failure (stream cut), not the end.
      if (playedMs < Math.min(5_000, finished.track.durationMs * 0.5)) {
        this.#failures += 1;
        this.#d.log.warn(
          { track: finished.track.id, playedMs, ffmpeg: this.#ffmpeg?.stderr() },
          'track stopped right after it started',
        );
        await this.#say(`⚠️ Lecture impossible : **${finished.track.title}**. Je passe au suivant.`);
        if (this.#failures >= MAX_CONSECUTIVE_FAILURES) {
          await this.end('Trop de titres illisibles d’affilée.');
          return;
        }
        this.queue.advance('skip');
        await this.#playOrFinish();
        return;
      }
      this.#failures = 0;
      await this.#reportTimeline('stopped');
    }
    this.queue.advance('ended');
    await this.#playOrFinish();
  }

  async #playOrFinish(): Promise<void> {
    if (this.queue.current) {
      await this.#play();
      return;
    }
    this.#stopSilently();
    this.#resource = undefined;
    await this.#card?.edit(idleCard('La file d’attente est terminée.')).catch(() => undefined);
    this.#card = undefined;
    this.#d.store.delete(this.#d.guild.id);
    this.startIdleTimer('Personne n’a relancé de musique.');
  }

  /** Streams the current entry from `seekMs`, replacing whatever was playing. */
  async #play(seekMs = 0, options: { keepCard?: boolean; keepOnError?: boolean } = {}): Promise<void> {
    const entry = this.queue.current;
    if (!entry) return this.#playOrFinish();
    const generation = ++this.#playGeneration;
    let playable;
    try {
      playable = await this.#d.plex.playable(entry.track.id);
      // A newer #play (a second tap on « next ») started meanwhile: it wins.
      if (generation !== this.#playGeneration) return;
    } catch (err) {
      if (generation !== this.#playGeneration) return;
      this.#d.log.warn({ err: (err as Error).message, track: entry.track.id }, 'cannot resolve track');
      if (options.keepOnError === true) {
        // A volume change or a seek: the track keeps playing as it was.
        await this.#say(
          '⚠️ Plex ne répond pas : je garde la lecture telle quelle, réessaie dans un instant.',
        );
        return;
      }
      this.#failures += 1;
      await this.#say(`⚠️ Plex ne trouve plus **${entry.track.title}**. Je passe au suivant.`);
      if (this.#failures >= MAX_CONSECUTIVE_FAILURES) return this.end('Trop de titres illisibles d’affilée.');
      this.queue.advance('skip');
      return this.#playOrFinish();
    }

    const previous = this.#ffmpeg;
    this.#pendingStartMs = undefined;
    // Read at each stream: the channel's bitrate can change while the bot plays.
    const channel = this.voiceChannelId ? this.#d.guild.channels.cache.get(this.voiceChannelId) : undefined;
    const bitrate = channel?.isVoiceBased() ? channel.bitrate : this.#bitrate;
    const ffmpeg = startFfmpeg(playable, { seekMs, bitrate, volume: this.#volume });
    this.#ffmpeg = ffmpeg;
    ffmpeg.process.on('error', (err) => {
      this.#d.log.error({ err: err.message }, 'cannot start ffmpeg');
    });
    const resource = createAudioResource(ffmpeg.process.stdout, {
      inputType: StreamType.OggOpus,
    });

    // play() replaces the current resource without an Idle event (AudioPlayer.play).
    this.#resource = resource;
    this.#offsetMs = seekMs;
    this.#scrobbled = seekMs >= entry.track.durationMs * SCROBBLE_RATIO;
    this.#player.play(resource);
    previous?.process.kill('SIGKILL');
    this.#d.log.info({ track: entry.track.id, seekMs }, 'playing');

    await this.#reportTimeline('playing');
    // A new track gets a new card at the bottom; a seek updates it. After a restart, there is
    // no card yet: one is posted.
    if ((seekMs === 0 && options.keepCard !== true) || !this.#card) await this.#sendCard();
    else await this.#refreshCard();
    this.save();
  }

  #stopSilently(): void {
    this.#stopping = true;
    try {
      this.#player.stop(true);
    } finally {
      this.#stopping = false;
    }
    this.#killFfmpeg();
  }

  #killFfmpeg(): void {
    this.#ffmpeg?.process.kill('SIGKILL');
    this.#ffmpeg = undefined;
  }

  #cancelIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  async #cover(track: Track): Promise<Cover> {
    if (!track.thumb) return { jpeg: undefined, accent: undefined };
    const cached = this.#covers.get(track.thumb);
    if (cached) return cached;
    const [jpeg, accent] = await Promise.all([
      this.#d.plex.cover(track.thumb).catch(() => undefined),
      this.#d.plex.accentColor(track.thumb).catch(() => undefined),
    ]);
    const cover = { jpeg, accent };
    if (this.#covers.size >= 20) this.#covers.delete(this.#covers.keys().next().value as string);
    this.#covers.set(track.thumb, cover);
    return cover;
  }

  async #view() {
    const entry = this.queue.current;
    if (!entry) return undefined;
    const cover = await this.#cover(entry.track);
    const card = nowPlayingCard({
      entry,
      elapsedMs: this.positionMs,
      paused: this.paused,
      loop: this.queue.loop,
      volume: this.#volume,
      upcoming: this.queue.upcoming,
      hasCover: cover.jpeg !== undefined,
      accentColor: cover.accent,
    });
    return { card, cover };
  }

  /**
   * A new card for a new track: the old one is deleted so the card stays at the bottom. It is
   * sent silent (SUPPRESS_NOTIFICATIONS, Discord message flags): no sound at each track.
   */
  async #sendCard(): Promise<void> {
    const view = await this.#view();
    if (!view || !this.#textChannel) return;
    const old = this.#card;
    try {
      this.#card = await this.#textChannel.send({
        ...view.card,
        flags: view.card.flags | MessageFlags.SuppressNotifications,
        files: view.cover.jpeg ? [new AttachmentBuilder(view.cover.jpeg, { name: COVER_NAME })] : [],
      });
    } catch (err) {
      this.#d.log.warn({ err: (err as Error).message }, 'cannot send the card');
      return;
    }
    await old?.delete().catch(() => undefined);
  }

  async #refreshCard(): Promise<void> {
    if (!this.#card) return;
    const view = await this.#view();
    if (!view) return;
    await this.#card.edit(view.card).catch((err: unknown) => {
      this.#d.log.debug({ err: (err as Error).message }, 'cannot edit the card');
    });
  }

  async #reportTimeline(state: 'playing' | 'paused' | 'stopped'): Promise<void> {
    const entry = this.queue.current;
    if (!entry || !this.#resource) return;
    if (state === 'playing' && this.paused) state = 'paused';
    const position = this.positionMs;
    try {
      await this.#d.plex.timeline(entry.track, state, position);
      if (!this.#scrobbled && position >= entry.track.durationMs * SCROBBLE_RATIO) {
        this.#scrobbled = true;
        await this.#d.plex.scrobble(entry.track.id);
      }
    } catch (err) {
      this.#d.log.debug({ err: (err as Error).message }, 'cannot report to Plex');
    }
  }

  async #say(text: string): Promise<void> {
    await this.#textChannel
      ?.send({ content: text, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications })
      .catch(() => undefined);
  }
}
