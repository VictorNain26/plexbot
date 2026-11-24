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
  #card: Message | undefined;
  #covers = new Map<string, Cover>();
  #timers: NodeJS.Timeout[] = [];
  #idleTimer: NodeJS.Timeout | undefined;
  #scrobbled = false;
  #failures = 0;
  /** Set while the bot itself stops the player (stop() emits Idle synchronously), so that Idle is not read as « track ended ». */
  #stopping = false;
  #ended = false;

  constructor(deps: SessionDeps) {
    this.#d = deps;
    this.#volume = deps.defaultVolume;
    this.#player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.#player.on(AudioPlayerStatus.Idle, () => void this.#onIdle());
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
    return (
      this.#player.state.status === AudioPlayerStatus.Paused ||
      this.#player.state.status === AudioPlayerStatus.AutoPaused
    );
  }

  get volume(): number {
    return this.#volume;
  }

  get positionMs(): number {
    return this.#offsetMs + (this.#resource?.playbackDuration ?? 0);
  }

  /** Joins (or moves to) a voice channel and waits until the connection is ready. */
  async join(channel: VoiceBasedChannel, textChannel: SendableChannels): Promise<void> {
    this.#textChannel = textChannel;
    if (this.#connection?.joinConfig.channelId === channel.id) return;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    this.#connection = connection;
    connection.subscribe(this.#player);
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
      if (this.#connection === connection) void this.end('Déconnecté du salon vocal.');
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  }

  /** Adds tracks; starts playing if nothing was. */
  async enqueue(
    tracks: readonly Track[],
    requestedBy: Requester,
    options: { next?: boolean } = {},
  ): Promise<void> {
    const wasIdle = this.queue.current === undefined;
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
    if (this.paused) this.#player.unpause();
    else this.#player.pause();
    await this.#reportTimeline(this.paused ? 'paused' : 'playing');
    await this.#refreshCard();
    return this.paused;
  }

  async skip(): Promise<void> {
    await this.#reportTimeline('stopped');
    this.queue.advance('skip');
    await this.#playOrFinish();
  }

  async skipTo(position: number): Promise<void> {
    await this.#reportTimeline('stopped');
    this.queue.skipTo(position);
    await this.#play();
  }

  async previous(): Promise<void> {
    await this.#reportTimeline('stopped');
    // Within the first seconds of a track, « previous » goes back a track; later, to its start.
    if (this.positionMs < 5_000) this.queue.previous();
    await this.#play();
  }

  async seek(ms: number): Promise<void> {
    const current = this.queue.current;
    if (!current) return;
    await this.#play(Math.min(Math.max(ms, 0), Math.max(current.track.durationMs - 1_000, 0)));
  }

  async setVolume(percent: number): Promise<void> {
    this.#volume = Math.min(Math.max(Math.round(percent), 0), 150);
    this.#resource?.volume?.setVolume(this.#volume / 100);
    await this.#refreshCard();
    this.save();
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

  /** Stops everything, leaves the channel and forgets the queue. */
  async end(reason: string): Promise<void> {
    if (this.#ended) return;
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
    await this.join(channel, textChannel);
    await this.#play(saved.positionMs);
    if (saved.paused) await this.togglePause();
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
  async #play(seekMs = 0): Promise<void> {
    const entry = this.queue.current;
    if (!entry) return this.#playOrFinish();
    let playable;
    try {
      playable = await this.#d.plex.playable(entry.track.id);
    } catch (err) {
      this.#d.log.warn({ err: (err as Error).message, track: entry.track.id }, 'cannot resolve track');
      this.#failures += 1;
      await this.#say(`⚠️ Plex ne trouve plus **${entry.track.title}**. Je passe au suivant.`);
      if (this.#failures >= MAX_CONSECUTIVE_FAILURES) return this.end('Trop de titres illisibles d’affilée.');
      this.queue.advance('skip');
      return this.#playOrFinish();
    }

    const previous = this.#ffmpeg;
    const ffmpeg = startFfmpeg(playable, seekMs);
    this.#ffmpeg = ffmpeg;
    ffmpeg.process.on('error', (err) => {
      this.#d.log.error({ err: err.message }, 'cannot start ffmpeg');
    });
    const resource = createAudioResource(ffmpeg.process.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume?.setVolume(this.#volume / 100);

    // play() replaces the current resource without an Idle event (AudioPlayer.play).
    this.#resource = resource;
    this.#offsetMs = seekMs;
    this.#scrobbled = seekMs >= entry.track.durationMs * SCROBBLE_RATIO;
    this.#player.play(resource);
    previous?.process.kill('SIGKILL');
    this.#d.log.info({ track: entry.track.id, seekMs }, 'playing');

    await this.#reportTimeline('playing');
    if (seekMs === 0) await this.#sendCard();
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

  /** A new card for a new track: the old one is deleted so the card stays at the bottom. */
  async #sendCard(): Promise<void> {
    const view = await this.#view();
    if (!view || !this.#textChannel) return;
    const old = this.#card;
    try {
      this.#card = await this.#textChannel.send({
        ...view.card,
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
    await this.#textChannel?.send({ content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
  }
}
