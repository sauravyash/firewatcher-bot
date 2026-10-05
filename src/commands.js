import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
].map((c) => c.toJSON());

const ephemeral = { flags: MessageFlags.Ephemeral };

export async function handleInteraction(interaction, { store, eve, verifier, config }) {
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
    case 'verify': {
      const state = randomBytes(24).toString('base64url');
      store.addPending(state, interaction.user.id);
      const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Log in with EVE Online')
        .setURL(eve.authorizeUrl(state));
      return interaction.reply({
        ...ephemeral,
        content:
          'Log in with EVE Online and pick the character to link. This link expires in 10 minutes.\n\n' +
          '**Alts:** run `/verify` again for each one. Alts on another EVE account: on the EVE login page, ' +
          'log out first (or use a private window), then sign in to the other account.',
        components: [new ActionRowBuilder().addComponents(button)],
      });
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

    case 'resync': {
      await interaction.deferReply(ephemeral);
      await verifier.syncAll();
      return interaction.editReply('Resync complete.');
    }
  }
}
