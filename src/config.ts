import { readFileSync } from 'node:fs';
import { z } from 'zod';

const snowflake = z.string().regex(/^[0-9]{17,20}$/, 'a Discord id (17 to 20 digits)');

const envSchema = z.object({
  DISCORD_GUILD_ID: snowflake,
  PLEX_URL: z.url(),
  // Docker secrets (compose `secrets:`): files, never environment variables.
  DISCORD_TOKEN_FILE: z.string().default('/run/secrets/discord_token'),
  PLEX_TOKEN_FILE: z.string().default('/run/secrets/plex_token'),
  PLEX_CLIENT_ID: z.string().min(1).default('plexbot'),
  DATA_DIR: z.string().default('/data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DEFAULT_VOLUME: z.coerce.number().int().min(0).max(150).default(100),
  IDLE_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
});

export interface Config {
  readonly guildId: string;
  readonly discordToken: string;
  readonly plex: { readonly url: string; readonly token: string; readonly clientId: string };
  readonly dataDir: string;
  readonly logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  readonly defaultVolume: number;
  readonly idleTimeoutMs: number;
}

function secret(path: string, name: string): string {
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(
      `cannot read the ${name} from ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      {
        cause: err,
      },
    );
  }
  if (value === '') throw new Error(`the ${name} file ${path} is empty`);
  return value;
}

/** Reads and checks the configuration once at start; an error names the setting, never a secret. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    guildId: e.DISCORD_GUILD_ID,
    discordToken: secret(e.DISCORD_TOKEN_FILE, 'Discord token'),
    plex: { url: e.PLEX_URL, token: secret(e.PLEX_TOKEN_FILE, 'Plex token'), clientId: e.PLEX_CLIENT_ID },
    dataDir: e.DATA_DIR,
    logLevel: e.LOG_LEVEL,
    defaultVolume: e.DEFAULT_VOLUME,
    idleTimeoutMs: e.IDLE_TIMEOUT_MS,
  };
}
