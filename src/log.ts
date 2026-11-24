import { pino } from 'pino';

/**
 * JSON logs on stdout (Docker keeps them). Token-bearing fields are redacted by name, so a
 * header object or a config logged by mistake prints « [secret] » instead of the value.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'plexbot' },
  redact: {
    paths: [
      'token',
      '*.token',
      'discordToken',
      '*.discordToken',
      'headers["X-Plex-Token"]',
      '*.headers["X-Plex-Token"]',
      'config.plex.token',
    ],
    censor: '[secret]',
  },
});

export type Logger = typeof log;
