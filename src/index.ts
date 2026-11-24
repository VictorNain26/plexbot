import { writeFileSync } from 'node:fs';
import { generateDependencyReport } from '@discordjs/voice';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { Bot } from './bot.js';
import { commandDefinitions } from './commands/definitions.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { PlexClient } from './plex/client.js';
import { Store } from './store/store.js';

// Set by the image build (GIT_SHA); Plex shows it as the client version.
const VERSION = process.env.PLEXBOT_VERSION ?? 'dev';
/** Touched while the gateway is ready; the Docker healthcheck reads its age. */
export const HEALTH_FILE = '/tmp/plexbot-healthy';

async function main(): Promise<void> {
  const config = loadConfig();
  log.level = config.logLevel;
  log.info({ report: generateDependencyReport() }, 'voice dependencies');

  const plex = new PlexClient({
    baseUrl: config.plex.url,
    token: config.plex.token,
    clientId: config.plex.clientId,
    version: VERSION,
  });
  const libraries = await plex.musicLibraries();
  // Only these libraries are played, whatever id an option value carries.
  plex.restrictTo(libraries.map((l) => l.id));
  log.info({ libraries }, 'Plex music libraries');

  const store = new Store(config.dataDir);
  // Only what a music bot needs: guilds (with the bot's own member) and voice states.
  // No privileged intent (members, message content, presences).
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    // No message of the bot ever pings: a display name like « @everyone » stays text.
    allowedMentions: { parse: [] },
  });
  const bot = new Bot({
    client,
    plex,
    store,
    log,
    guildId: config.guildId,
    libraries,
    defaultVolume: config.defaultVolume,
    idleTimeoutMs: config.idleTimeoutMs,
  });

  client.once(Events.ClientReady, (c) => {
    onReady(c).catch((err: unknown) => {
      log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'cannot get ready');
      process.exit(1);
    });
  });

  async function onReady(c: Client<true>): Promise<void> {
    const guild = await c.guilds.fetch(config.guildId).catch(() => undefined);
    if (!guild) {
      log.fatal({ guildId: config.guildId }, 'the bot is not in its guild: invite it first');
      process.exit(1);
    }
    // Guild commands apply at once, unlike global ones.
    await guild.commands.set(commandDefinitions(libraries));
    log.info({ user: c.user.tag, guild: guild.name }, 'ready');

    const saved = store.load(guild.id);
    if (saved) {
      const voice = guild.channels.cache.get(saved.voiceChannelId);
      const text = guild.channels.cache.get(saved.textChannelId);
      if (voice?.isVoiceBased() && text?.isSendable()) {
        await bot
          .session(guild)
          .restore(saved, voice, text)
          .then(() => {
            log.info({ tracks: saved.items.length }, 'session restored');
          })
          .catch((err: unknown) => {
            log.warn({ err: (err as Error).message }, 'cannot restore the session');
          });
      } else {
        store.delete(guild.id);
      }
    }
  }

  client.on(Events.InteractionCreate, (i) => {
    void bot.handle(i);
  });
  client.on(Events.VoiceStateUpdate, (_before, after) => {
    bot.onVoiceChange(after.guild);
  });
  client.on(Events.Error, (err) => {
    log.error({ err: err.message }, 'client error');
  });

  setInterval(() => {
    if (client.isReady()) writeFileSync(HEALTH_FILE, String(Date.now()));
  }, 20_000).unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    // Saved first: a restart (update, reboot) resumes the queue where it was.
    bot.prepareShutdown();
    await client.destroy();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    await client.login(config.discordToken);
  } catch (err) {
    // The message only: discord.js errors carry no token, and none is added here.
    log.fatal({ err: (err as Error).message }, 'cannot log in to Discord');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'cannot start');
  process.exit(1);
});
