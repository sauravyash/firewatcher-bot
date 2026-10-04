import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { Store } from './db.js';
import { EveClient } from './eve.js';
import { Verifier } from './verifier.js';
import { startWebServer } from './web.js';
import { commandData, handleInteraction } from './commands.js';

// Only the non-privileged Guilds intent: members are fetched one at a time over REST when needed.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const store = new Store(config.dbPath);
const eve = new EveClient({ ...config.eve, contactEmail: config.contactEmail });
const verifier = new Verifier({ client, store, eve, config });
const deps = { store, eve, verifier, config };

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  const guild = await c.guilds.fetch(config.guildId);
  await guild.commands.set(commandData); // guild-scoped commands show up instantly
  startWebServer(deps);

  setInterval(() => verifier.syncAll().catch((err) => console.error('Periodic sync failed:', err)), config.syncMinutes * 60_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction, deps);
  } catch (err) {
    console.error('Command failed:', err);
    if (!interaction.isRepliable()) return;
    const reply = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.login(config.discordToken);
