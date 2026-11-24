/** A playable Plex track, as the queue and the cards need it. */
export interface Track {
  /** Plex ratingKey of the track. */
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly year: number | undefined;
  readonly durationMs: number;
  /** Plex path of the cover (album thumb), fetched through the bot, never sent to Discord. */
  readonly thumb: string | undefined;
  readonly library: string;
}

/** Who added a track to the queue. */
export interface Requester {
  readonly id: string;
  readonly name: string;
}

export interface QueueEntry {
  /** Unique per entry: the same track can be queued twice. */
  readonly uid: string;
  readonly track: Track;
  readonly requestedBy: Requester;
}

export type LoopMode = 'off' | 'track' | 'queue';
