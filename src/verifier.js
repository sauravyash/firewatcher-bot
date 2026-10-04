const UNKNOWN_MEMBER = 10007;
const NICK_MAX = 32; // Discord's limit; EVE names can be up to 37 characters

/** A link attempt the user should be told about (not a bug). */
export class LinkError extends Error {}

export class Verifier {
  constructor({ client, store, eve, config }) {
    this.client = client;
    this.store = store;
    this.eve = eve;
    this.config = config;
  }

  async linkCharacter(discordId, login) {
    const existing = this.store.getCharacter(login.characterId);
    let previousDiscordId = null;
    if (existing && existing.discord_id !== discordId) {
      if (existing.owner_hash === login.ownerHash) {
        throw new LinkError(
          `${login.name} is already linked to a different Discord account. Ask an admin if this is wrong.`,
        );
      }
      // Owner hash changed: the character was sold or transferred, so the new owner takes it over.
      previousDiscordId = existing.discord_id;
    }

    const affiliation = (await this.eve.affiliations([login.characterId])).get(login.characterId);
    this.store.upsertCharacter({
      discordId,
      characterId: login.characterId,
      name: login.name,
      ownerHash: login.ownerHash,
      corporationId: affiliation?.corporationId ?? null,
      allianceId: affiliation?.allianceId ?? null,
    });

    if (previousDiscordId) {
      this.store.ensureMain(previousDiscordId);
      await this.syncMember(previousDiscordId);
    }
    await this.syncMember(discordId);

    const chars = this.store.charactersFor(discordId);
    const role = chars[0].character_id === login.characterId ? 'main' : 'alt';
    return `Linked ${login.name} as your ${role}. You now have ${chars.length} linked character(s). You can close this tab.`;
  }

  isAllowed(character) {
    const { allowedCorporations, allowedAlliances } = this.config;
    if (allowedCorporations.size === 0 && allowedAlliances.size === 0) return true;
    return allowedCorporations.has(character.corporation_id) || allowedAlliances.has(character.alliance_id);
  }

  async nicknameFor(main) {
    const corp = await this.eve.ticker('corporations', main.corporation_id);
    const alliance = await this.eve.ticker('alliances', main.alliance_id);
    const nick = this.config.nickFormat
      .replaceAll('{corp}', corp)
      .replaceAll('{alliance}', alliance)
      .replaceAll('{name}', main.name)
      .replace(/\[\]\s*/g, '')
      .trim();
    return nick.slice(0, NICK_MAX);
  }

  /** Makes a member's roles and nickname match their linked characters. */
  async syncMember(discordId) {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch (err) {
      if (err.code === UNKNOWN_MEMBER) return; // left the server
      throw err;
    }

    const chars = this.store.charactersFor(discordId);
    const main = chars[0];
    const roleSource = this.config.rolesFrom === 'main' ? chars.slice(0, 1) : chars;

    const wanted = new Map([[this.config.verifiedRoleId, chars.length > 0]]);
    if (this.config.memberRoleId) {
      wanted.set(this.config.memberRoleId, roleSource.some((c) => this.isAllowed(c)));
    }
    const add = [...wanted].filter(([id, on]) => on && !member.roles.cache.has(id)).map(([id]) => id);
    const remove = [...wanted].filter(([id, on]) => !on && member.roles.cache.has(id)).map(([id]) => id);
    if (add.length) await member.roles.add(add, 'EVE verification');
    if (remove.length) await member.roles.remove(remove, 'EVE verification');

    // `manageable` is false for the server owner and anyone above the bot's highest role.
    if (this.config.setNicknames && member.manageable) {
      const nick = main ? await this.nicknameFor(main) : null;
      if (member.nickname !== nick) await member.setNickname(nick, 'EVE verification');
    }
  }

  /** Refreshes every character's corp/alliance from ESI and re-syncs every linked member. */
  async syncAll() {
    const chars = this.store.allCharacters();
    if (chars.length) {
      const affiliations = await this.eve.affiliations(chars.map((c) => c.character_id));
      for (const [characterId, a] of affiliations) {
        this.store.updateAffiliation(characterId, a.corporationId, a.allianceId);
      }
    }
    for (const discordId of this.store.allDiscordIds()) {
      try {
        await this.syncMember(discordId);
      } catch (err) {
        console.error(`Failed to sync member ${discordId}:`, err);
      }
    }
  }
}
