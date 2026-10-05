import { readFileSync } from 'node:fs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

function idList(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// EVE faction ids. Faction warfare pairs them into two warzone sides.
const CALDARI_STATE = 500001;
const MINMATAR_REPUBLIC = 500002;
const AMARR_EMPIRE = 500003;
const GALLENTE_FEDERATION = 500004;

const DISCORD_ID = /^\d{17,20}$/;

/**
 * Turns one server's raw settings (from guilds.json or the single-server .env variables) into the
 * shape the verifier uses. `where` names the source in error messages.
 */
function guildConfig(guildId, raw, where) {
  const discordId = (obj, key, at, { optional = false } = {}) => {
    const value = obj[key];
    if (value == null || value === '') {
      if (optional) return null;
      throw new Error(`${at}: missing ${key}`);
    }
    // Discord ids are too big for JSON numbers, which silently round them.
    if (typeof value !== 'string' || !DISCORD_ID.test(value)) {
      throw new Error(`${at}: ${key} must be a Discord id written as a string, e.g. "123456789012345678"`);
    }
    return value;
  };
  const eveIds = (obj, key, at) => {
    const value = obj[key] ?? [];
    const list = Array.isArray(value) ? value : idList(value);
    const ids = list.map(Number);
    if (!ids.every(Number.isInteger)) throw new Error(`${at}: ${key} must be a list of EVE ids`);
    return new Set(ids);
  };
  const optional = { optional: true };
  if (!DISCORD_ID.test(guildId)) throw new Error(`${where}: "${guildId}" is not a Discord server id`);

  // One role per corp or group of corps/alliances: [{ name, roleId, corporations, alliances }].
  if (raw.corpRoles != null && !Array.isArray(raw.corpRoles)) throw new Error(`${where}: corpRoles must be a list`);
  const corpRoles = (raw.corpRoles ?? []).map((r, i) => {
    const at = `${where} → corpRoles[${i}]`;
    const rule = {
      name: r.name || `corpRoles[${i}]`,
      roleId: discordId(r, 'roleId', at),
      corporations: eveIds(r, 'corporations', at),
      alliances: eveIds(r, 'alliances', at),
    };
    if (!rule.corporations.size && !rule.alliances.size) {
      throw new Error(`${at}: list at least one id in corporations or alliances`);
    }
    return rule;
  });
  // The original single corp member role. With no corps or alliances listed, everyone qualifies.
  const corpMemberRoleId = discordId(raw, 'corpMemberRoleId', where, optional);
  if (corpMemberRoleId) {
    corpRoles.push({
      name: 'corp member',
      roleId: corpMemberRoleId,
      corporations: eveIds(raw, 'allowedCorporations', where),
      alliances: eveIds(raw, 'allowedAlliances', where),
    });
  }

  return {
    guildId,
    name: raw.name || guildId,

    // Optional: given to anyone with at least one linked character.
    verifiedRoleId: discordId(raw, 'verifiedRoleId', where, optional),
    // Each given if a character is in one of the rule's corps or alliances.
    corpRoles,
    // Optional faction warfare roles: given if a character's corp is enlisted with that side's militia.
    // Independent of the corp roles, so allies and other FW pilots get them too.
    militiaRoles: [
      { roleId: discordId(raw, 'amarrMilitiaRoleId', where, optional), factions: new Set([AMARR_EMPIRE, CALDARI_STATE]) },
      {
        roleId: discordId(raw, 'gallenteMilitiaRoleId', where, optional),
        factions: new Set([GALLENTE_FEDERATION, MINMATAR_REPUBLIC]),
      },
    ].filter((r) => r.roleId),
    // "any": a role applies if ANY linked character qualifies. "main": only the main counts.
    rolesFrom: raw.rolesFrom === 'main' ? 'main' : 'any',

    setNicknames: raw.setNicknames !== false && raw.setNicknames !== 'false',
    // Placeholders: {name} {corp} {alliance}. Empty [] brackets are stripped.
    nickFormat: raw.nickFormat || '[{corp}] {name}',
  };
}

/** Per-server settings from the GUILDS_FILE JSON, keyed by Discord server id. */
function guildsFromFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read GUILDS_FILE ${path}: ${err.message}`);
  }
  const entries = Object.entries(parsed.guilds ?? {});
  if (!entries.length) throw new Error(`${path} has no servers under "guilds" (see guilds.example.json)`);
  return new Map(entries.map(([id, raw]) => [id, guildConfig(id, raw, `${path} → ${id}`)]));
}

/** The original single-server setup, configured entirely from .env. */
function guildFromEnv() {
  if (process.env.MEMBER_ROLE_ID && !process.env.CORP_MEMBER_ROLE_ID) {
    throw new Error('MEMBER_ROLE_ID was renamed to CORP_MEMBER_ROLE_ID; update your .env');
  }
  const guildId = required('GUILD_ID');
  const env = (name) => process.env[name];
  const raw = {
    verifiedRoleId: env('VERIFIED_ROLE_ID'),
    corpMemberRoleId: env('CORP_MEMBER_ROLE_ID'),
    allowedCorporations: env('ALLOWED_CORPORATIONS'),
    allowedAlliances: env('ALLOWED_ALLIANCES'),
    amarrMilitiaRoleId: env('AMARR_MILITIA_ROLE_ID'),
    gallenteMilitiaRoleId: env('GALLENTE_MILITIA_ROLE_ID'),
    rolesFrom: env('ROLES_FROM'),
    setNicknames: env('SET_NICKNAMES'),
    nickFormat: env('NICK_FORMAT'),
  };
  return new Map([[guildId, guildConfig(guildId, raw, '.env')]]);
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),

  // Map<guildId, settings>. With GUILDS_FILE set, the single-server variables in .env are ignored.
  guilds: process.env.GUILDS_FILE ? guildsFromFile(process.env.GUILDS_FILE) : guildFromEnv(),

  eve: {
    clientId: required('EVE_CLIENT_ID'),
    clientSecret: required('EVE_CLIENT_SECRET'),
    callbackUrl: required('EVE_CALLBACK_URL'),
  },
  contactEmail: required('CONTACT_EMAIL'),

  webPort: Number(process.env.WEB_PORT || 8080),
  dbPath: process.env.DB_PATH || 'firewatcher-bot.db',
  syncMinutes: Number(process.env.SYNC_MINUTES || 60),
};
