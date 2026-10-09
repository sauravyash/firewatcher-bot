import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const characterOption = (o) =>
  o.setName('character').setDescription('One of your linked characters').setRequired(true).setAutocomplete(true);

export const commandData = [
  new SlashCommandBuilder().setName('verify').setDescription('Link an EVE character (run again for each alt)'),
  new SlashCommandBuilder().setName('characters').setDescription('List your linked EVE characters'),
  new SlashCommandBuilder()
    .setName('setmain')
    .setDescription('Choose which character sets your nickname')
    .addStringOption(characterOption),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink one of your characters').addStringOption(characterOption),
  new SlashCommandBuilder()
    .setName('whois')
    .setDescription('Show the EVE characters linked to a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('member').setDescription('Member to look up').setRequired(true)),
  new SlashCommandBuilder()
    .setName('whochar')
    .setDescription('Find which member owns an EVE character')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((o) => o.setName('name').setDescription('Exact character name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('resync')
    .setDescription('Refresh corp/alliance data and re-apply roles for everyone in every server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder()
    .setName('post-verify')
    .setDescription('Post a "Verify with EVE Online" button in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
].map((c) => c.toJSON());

const ephemeral = { flags: MessageFlags.Ephemeral };
const VERIFY_BUTTON = 'verify:start';
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

/** The private reply with a fresh, single-use EVE login link for whoever ran /verify or clicked the button. */
function verifyReply(interaction, store, eve) {
  const state = randomBytes(24).toString('base64url');
  store.addPending(state, interaction.user.id);
  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Log in with EVE Online')
    .setURL(eve.authorizeUrl(state));
  return interaction.reply({
    ...ephemeral,
    content:
      'Log in with EVE Online and pick the character to link. This link is only for you and expires in 10 minutes.\n\n' +
      '**Alts:** verify again for each one. Alts on another EVE account: on the EVE login page, ' +
      'log out first (or use a private window), then sign in to the other account.',
    components: [new ActionRowBuilder().addComponents(button)],
  });
}

/** A verify message with the shared button. The button carries no link; each click gets its own. */
function verifyMessage(title, description) {
  return {
    embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle(title).setDescription(description)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(VERIFY_BUTTON).setStyle(ButtonStyle.Primary).setLabel('Verify with EVE Online'),
      ),
    ],
  };
}

/** The shared message staff post with /post-verify. */
function verifyPanel() {
  return verifyMessage(
    'Verify your EVE character',
    'Click **Verify with EVE Online** to link your character. You get a private login link that only ' +
      "you can see. Log in on EVE Online's own site and pick your character, and your roles and " +
      'nickname are set automatically.\n\n' +
      'Have alts? Click again for each one. You can also use `/verify` anywhere.',
  );
}

/**
 * Greets a member who just joined a configured server. Members who already linked a character (say,
 * rejoining) get their roles back right away; everyone else gets a DM with the verify button.
 */
export async function welcomeMember(member, { store, verifier }) {
  const guildConfig = verifier.guilds.get(member.guild.id);
  if (!guildConfig || member.user.bot) return;

  if (store.charactersFor(member.id).length) return verifier.syncMemberIn(guildConfig, member.id);

  try {
    await member.send(
      verifyMessage(
        `Welcome to ${member.guild.name}`,
        'To get your roles, link your EVE character. Click **Verify with EVE Online** below, log in on ' +
          "EVE Online's own site and pick your character. Your roles and nickname are set automatically.\n\n" +
          `Have alts? Click again for each one. You can also use \`/verify\` in ${member.guild.name}.`,
      ),
    );
  } catch (err) {
    // Members with DMs from server members turned off. The panel from /post-verify covers them.
    console.warn(`Couldn't DM the verify button to ${member.user.tag} (${member.guild.name}): ${err.message}`);
  }
}

export async function handleInteraction(interaction, { store, eve, verifier, roleManager, config }) {
  // The verify button also lives in welcome DMs, where there's no server to check.
  if (interaction.isButton() && interaction.customId === VERIFY_BUTTON) return verifyReply(interaction, store, eve);

  // Leftover commands in a server that was removed from the config.
  if (!config.guilds.has(interaction.guildId)) {
    if (interaction.isRepliable()) {
      await interaction.reply({ ...ephemeral, content: "This server isn't set up for EVE verification." });
    }
    return;
  }

  // Admin lookups only reveal members of the server they're run in.
  const inThisServer = async (discordId) => Boolean(await verifier.fetchMember(interaction.guildId, discordId));

  if (interaction.isAutocomplete()) {
    const typed = interaction.options.getFocused().toLowerCase();
    const choices = store
      .charactersFor(interaction.user.id)
      .filter((c) => c.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((c) => ({ name: c.name, value: String(c.character_id) }));
    return interaction.respond(choices);
  }
  if (!interaction.isChatInputCommand()) return;

  const describe = async (c) => {
    const corp = await eve.ticker('corporations', c.corporation_id);
    const alliance = await eve.ticker('alliances', c.alliance_id);
    const tags = [corp && `[${corp}]`, alliance && `<${alliance}>`].filter(Boolean).join(' ');
    return `${c.is_main ? '★' : '•'} **${c.name}** ${tags}${c.is_main ? ' (main)' : ''}`;
  };
  const describeAll = async (chars) => (await Promise.all(chars.map(describe))).join('\n');

  switch (interaction.commandName) {
    case 'verify':
      return verifyReply(interaction, store, eve);

    case 'post-verify': {
      await interaction.deferReply(ephemeral);
      try {
        const channel = interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId));
        await channel.send(verifyPanel());
      } catch (err) {
        if (err.code !== MISSING_ACCESS && err.code !== MISSING_PERMISSIONS) throw err;
        return interaction.editReply(
          "I can't post in this channel. Give my role **View Channel**, **Send Messages** and **Embed Links** here, then try again.",
        );
      }
      return interaction.editReply('Posted. Pin it if you like, and delete any old verify messages.');
    }

    case 'characters': {
      await interaction.deferReply(ephemeral);
      const chars = store.charactersFor(interaction.user.id);
      return interaction.editReply(chars.length ? await describeAll(chars) : 'No linked characters yet. Use `/verify`.');
    }

    case 'setmain': {
      await interaction.deferReply(ephemeral);
      const characterId = Number(interaction.options.getString('character', true));
      if (!store.setMain(interaction.user.id, characterId)) {
        return interaction.editReply("That character isn't linked to you.");
      }
      await verifier.syncMember(interaction.user.id);
      return interaction.editReply(`Main set to **${store.getCharacter(characterId).name}**.`);
    }

    case 'unlink': {
      await interaction.deferReply(ephemeral);
      const characterId = Number(interaction.options.getString('character', true));
      const character = store.getCharacter(characterId);
      if (!store.removeCharacter(interaction.user.id, characterId)) {
        return interaction.editReply("That character isn't linked to you.");
      }
      await verifier.syncMember(interaction.user.id);
      return interaction.editReply(`Unlinked **${character.name}**.`);
    }

    case 'whois': {
      await interaction.deferReply(ephemeral);
      const user = interaction.options.getUser('member', true);
      const chars = (await inThisServer(user.id)) ? store.charactersFor(user.id) : [];
      return interaction.editReply({
        content: chars.length ? `<@${user.id}>:\n${await describeAll(chars)}` : `<@${user.id}> has no linked characters.`,
        allowedMentions: { parse: [] },
      });
    }

    case 'whochar': {
      await interaction.deferReply(ephemeral);
      let character = store.findCharacterByName(interaction.options.getString('name', true));
      if (character && !(await inThisServer(character.discord_id))) character = null;
      return interaction.editReply({
        content: character
          ? `**${character.name}** belongs to <@${character.discord_id}>.`
          : 'No member of this server has linked that character.',
        allowedMentions: { parse: [] },
      });
    }

    case 'manage-roles':
      if (!roleManager) return interaction.reply({ ...ephemeral, content: "The role manager isn't set up." });
      return roleManager.handleCommand(interaction);

    case 'resync': {
      await interaction.deferReply(ephemeral);
      await verifier.syncAll();
      return interaction.editReply('Resync complete.');
    }
  }
}
