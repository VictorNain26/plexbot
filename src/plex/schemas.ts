import { z } from 'zod';

// Only the fields the bot reads. Plex sends many more; zod drops them. Field names follow the
// Plex Media Server API (developer.plex.tv/pms), checked against the server's own JSON answers.

const stream = z.object({
  streamType: z.number(),
  gain: z.coerce.number().optional(),
  albumGain: z.coerce.number().optional(),
});

const part = z.object({
  key: z.string(),
  Stream: z.array(stream).optional(),
});

const media = z.object({ Part: z.array(part).min(1) });

export const metadataSchema = z.object({
  ratingKey: z.string(),
  type: z.string(),
  title: z.string(),
  originalTitle: z.string().optional(),
  parentTitle: z.string().optional(),
  grandparentTitle: z.string().optional(),
  parentYear: z.number().optional(),
  year: z.number().optional(),
  duration: z.number().optional(),
  thumb: z.string().optional(),
  parentThumb: z.string().optional(),
  librarySectionID: z.number().optional(),
  librarySectionTitle: z.string().optional(),
  leafCount: z.number().optional(),
  playlistType: z.string().optional(),
  Media: z.array(media).optional(),
});
export type Metadata = z.infer<typeof metadataSchema>;

export const metadataContainerSchema = z.object({
  MediaContainer: z.object({
    totalSize: z.number().optional(),
    // An album's children carry their library only here, on the container.
    librarySectionID: z.number().optional(),
    librarySectionTitle: z.string().optional(),
    Metadata: z.array(metadataSchema).default([]),
  }),
});

export const hubSearchSchema = z.object({
  MediaContainer: z.object({
    Hub: z.array(z.object({ type: z.string(), Metadata: z.array(metadataSchema).default([]) })).default([]),
  }),
});

export const sectionsSchema = z.object({
  MediaContainer: z.object({
    Directory: z.array(z.object({ key: z.string(), type: z.string(), title: z.string() })).default([]),
  }),
});

export const ultraBlurSchema = z.object({
  MediaContainer: z.object({
    UltraBlurColors: z.array(z.object({ topLeft: z.string(), bottomRight: z.string() })).default([]),
  }),
});
