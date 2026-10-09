import { loadGuilds } from './config.js';

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
    this.guilds = config.guilds;
  }

  /**
   * Re-reads GUILDS_FILE so edits apply on the next sync without a restart. A file with mistakes is
   * logged and the last good settings are kept. Adding or removing a server needs a restart, since
   * slash commands are registered per server at startup.
   */
  reloadGuilds() {
    if (!process.env.GUILDS_FILE) return;
    try {
      const next = loadGuilds();
      const same = next.size === this.guilds.size && [...next.keys()].every((id) => this.guilds.has(id));
      if (!same) throw new Error('servers were added or removed. Restart the bot to apply that.');
      this.guilds = next;
    } catch (err) {
      console.error(`Keeping the previous server settings: ${err.message}`);
    }
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

    // The link is saved at this point. A failed role update (usually the bot's role sitting below the
    // roles it hands out) is logged by syncMember and retried on the next sync.
    if (previousDiscordId) {
      this.store.ensureMain(previousDiscordId);
      await this.syncMember(previousDiscordId).catch(() => {});
    }
    const synced = await this.syncMember(discordId).then(() => true, () => false);

    const chars = this.store.charactersFor(discordId);
    const role = chars[0].character_id === login.characterId ? 'main' : 'alt';
    const linked = `Linked ${login.name} as your ${role}. You now have ${chars.length} linked character(s).`;
    const status = synced
      ? linked
      : `${linked} Your Discord roles couldn't be updated right now; a server admin needs to check the bot's permissions. They'll be applied on the next sync.`;
    await this.notifyLinked(discordId, status);
    return synced ? `${status} You can close this tab.` : status;
  }

  /** DMs a member about a successful link. Members with DMs closed (or no shared server) are skipped. */
  async notifyLinked(discordId, message) {
    try {
      const user = await this.client.users.fetch(discordId);
      await user.send(`✅ ${message}`);
    } catch (err) {
      console.warn(`Couldn't DM ${discordId} about their new link: ${err.message}`);
    }
  }

  /** Whether a character is in one of a corp role's corps or alliances. A rule listing neither matches everyone. */
  matchesCorpRole(rule, character) {
    const { corporations, alliances } = rule;
    if (corporations.size === 0 && alliances.size === 0) return true;
    return corporations.has(character.corporation_id) || alliances.has(character.alliance_id);
  }

  /**
   * Role rules from the role manager panel's entries, in the same shape as corpRoles. Unlinked entries
   * and roles deleted in Discord are skipped, so a missing role doesn't fail the whole member.
   */
  managedRules(guild) {
    return this.store
      .roleEntries(guild.id)
      .filter((e) => e.role_id && guild.roles.cache.has(e.role_id))
      .map((e) => ({
        name: e.name,
        roleId: e.role_id,
        corporations: new Set(e.kind === 'corporation' ? [e.eve_id] : []),
        alliances: new Set(e.kind === 'alliance' ? [e.eve_id] : []),
      }));
  }

  async nicknameFor(guildConfig, main) {
    const corp = await this.eve.ticker('corporations', main.corporation_id);
    const alliance = await this.eve.ticker('alliances', main.alliance_id);
    const nick = guildConfig.nickFormat
      .replaceAll('{corp}', corp)
      .replaceAll('{alliance}', alliance)
      .replaceAll('{name}', main.name)
      .replace(/\[\]\s*/g, '')
      .trim();
    return nick.slice(0, NICK_MAX);
  }

  /**
   * Makes a member's roles and nickname match their linked characters, in every configured server
   * they're in. Linked characters are shared across servers; each server applies its own rules.
   */
  async syncMember(discordId) {
    const failures = [];
    for (const guildConfig of this.guilds.values()) {
      try {
        await this.syncMemberIn(guildConfig, discordId);
      } catch (err) {
        failures.push(err);
        console.error(`Failed to sync member ${discordId} in ${guildConfig.name}:`, err);
      }
    }
    if (failures.length) throw failures[0];
  }

  /** The member in a configured server, or null if they aren't in it. */
  async fetchMember(guildId, discordId) {
    const guild = await this.client.guilds.fetch(guildId);
    try {
      return await guild.members.fetch(discordId);
    } catch (err) {
      if (err.code === UNKNOWN_MEMBER) return null;
      throw err;
    }
  }

  async syncMemberIn(guildConfig, discordId) {
    const member = await this.fetchMember(guildConfig.guildId, discordId);
    if (!member) return;

    const chars = this.store.charactersFor(discordId);
    const main = chars[0];
    const roleSource = guildConfig.rolesFrom === 'main' ? chars.slice(0, 1) : chars;

    // Several rules may share a role; it's kept if any of them qualifies.
    const wanted = new Map();
    const want = (roleId, on) => wanted.set(roleId, wanted.get(roleId) || on);
    if (guildConfig.verifiedRoleId) want(guildConfig.verifiedRoleId, chars.length > 0);
    for (const rule of [...guildConfig.corpRoles, ...this.managedRules(member.guild)]) {
      want(rule.roleId, roleSource.some((c) => this.matchesCorpRole(rule, c)));
    }
    if (guildConfig.militiaRoles.length) {
      const factions = await Promise.all(roleSource.map((c) => this.eve.militiaFaction(c)));
      for (const { roleId, factions: side } of guildConfig.militiaRoles) {
        want(roleId, factions.some((f) => side.has(f)));
      }
    }
    const add = [...wanted].filter(([id, on]) => on && !member.roles.cache.has(id)).map(([id]) => id);
    const remove = [...wanted].filter(([id, on]) => !on && member.roles.cache.has(id)).map(([id]) => id);
    if (add.length) await member.roles.add(add, 'EVE verification');
    if (remove.length) await member.roles.remove(remove, 'EVE verification');

    // `manageable` is false for the server owner and anyone above the bot's highest role.
    if (guildConfig.setNicknames && member.manageable) {
      const nick = main ? await this.nicknameFor(guildConfig, main) : null;
      if (member.nickname !== nick) await member.setNickname(nick, 'EVE verification');
    }
  }

  /**
   * Reloads GUILDS_FILE, refreshes every character's corp/alliance from ESI and re-syncs every linked
   * member. One sync runs at a time; asking during a sync runs one more after it, so no change is missed.
   */
  syncAll() {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.syncAllOnce();
      } while (this.syncAgain);
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async syncAllOnce() {
    this.reloadGuilds();
    this.eve.clearCache();
    const chars = this.store.allCharacters();
    if (chars.length) {
      const affiliations = await this.eve.affiliations(chars.map((c) => c.character_id));
      for (const [characterId, a] of affiliations) {
        this.store.updateAffiliation(characterId, a.corporationId, a.allianceId);
      }
    }
    for (const discordId of this.store.allDiscordIds()) {
      // syncMember already logged the failure; keep going with everyone else.
      await this.syncMember(discordId).catch(() => {});
    }
  }
}
