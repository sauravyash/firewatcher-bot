import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { Store } from './db.js';
import { EveClient } from './eve.js';
import { Verifier } from './verifier.js';
import { startWebServer } from './web.js';
import { commandData, handleInteraction, welcomeMember } from './commands.js';
import { RoleManager, manageRolesCommand } from './panel.js';

// GuildMembers (privileged: enable "Server Members Intent" in the Developer Portal) is only for join
// events. Members are still fetched one at a time over REST when needed.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const store = new Store(config.dbPath);
const eve = new EveClient({ ...config.eve, contactEmail: config.contactEmail });
const verifier = new Verifier({ client, store, eve, config });
const roleManager = config.manager ? new RoleManager({ client, store, eve, verifier, config }) : null;
const deps = { store, eve, verifier, roleManager, config };

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  for (const { guildId, name } of config.guilds.values()) {
    try {
      const guild = await c.guilds.fetch(guildId);
      // Guild-scoped commands show up instantly. /manage-roles only exists on the role manager's server.
      await guild.commands.set(guildId === config.manager?.guildId ? [...commandData, manageRolesCommand] : commandData);
      console.log(`Serving ${guild.name} (${guildId})`);
    } catch (err) {
      console.error(`Could not set up ${name}: is the bot invited to that server?`, err.message);
    }
  }
  startWebServer(deps);

  // Sync once at startup so role changes in the settings reach every linked member without waiting.
  verifier.syncAll().catch((err) => console.error('Startup sync failed:', err));

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

client.on(Events.GuildMemberAdd, (member) => {
  welcomeMember(member, deps).catch((err) => console.error(`Welcoming ${member.user.tag} failed:`, err));
});

client.login(config.discordToken).catch((err) => {
  if (/disallowed intents/i.test(err.message)) {
    console.error('Turn on "Server Members Intent" under Bot > Privileged Gateway Intents in the Discord Developer Portal.');
  }
  throw err;
});
