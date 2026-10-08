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

// Settings key → the militia factions that earn that role.
const MILITIA_ROLES = {
  amarrMilitiaRoleId: [AMARR_EMPIRE, CALDARI_STATE],
  gallenteMilitiaRoleId: [GALLENTE_FEDERATION, MINMATAR_REPUBLIC],
  amarrRoleId: [AMARR_EMPIRE],
  caldariRoleId: [CALDARI_STATE],
  gallenteRoleId: [GALLENTE_FEDERATION],
  minmatarRoleId: [MINMATAR_REPUBLIC],
};

const GUILD_KEYS = [
  'name', 'verifiedRoleId', 'corpRoles', 'allianceRoles', 'corpMemberRoleId', 'allowedCorporations',
  'allowedAlliances', ...Object.keys(MILITIA_ROLES), 'rolesFrom', 'setNicknames', 'nickFormat',
];

const DISCORD_ID = /^\d{17,20}$/;

/** Collects every problem instead of stopping at the first, so a bad edit can be fixed in one pass. */
class Problems {
  list = [];

  add(at, message) {
    this.list.push(`${at}: ${message}`);
  }

  isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Flags misspelled or unknown fields, which would otherwise be silently ignored. */
  knownKeys(at, obj, keys) {
    if (!this.isObject(obj)) {
      this.add(at, 'must be an object { ... }');
      return false;
    }
    for (const key of Object.keys(obj)) {
      if (!keys.includes(key)) this.add(at, `unknown field "${key}" (expected one of: ${keys.join(', ')})`);
    }
    return true;
  }

  discordId(at, obj, key, { optional = false } = {}) {
    const value = obj[key];
    if (value == null || value === '') {
      if (!optional) this.add(at, `missing ${key}`);
      return null;
    }
    // Discord ids are too big for JSON numbers, which silently round them.
    if (typeof value === 'number') {
      this.add(at, `${key} must be in quotes (${value} may already be rounded; copy the id from Discord again)`);
      return null;
    }
    if (typeof value !== 'string' || !DISCORD_ID.test(value)) {
      this.add(at, `${key} must be a Discord id written as a string, e.g. "123456789012345678"`);
      return null;
    }
    return value;
  }

  eveId(at, value) {
    const id = Number(value);
    if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(id) || id === 0) {
      this.add(at, `${JSON.stringify(value)} is not an EVE id (a whole number)`);
      return null;
    }
    return id;
  }

  eveIds(at, obj, key) {
    const value = obj[key] ?? [];
    if (!Array.isArray(value) && typeof value !== 'string') {
      this.add(at, `${key} must be a list of EVE ids`);
      return new Set();
    }
    const list = Array.isArray(value) ? value : idList(value);
    return new Set(list.map((v) => this.eveId(`${at} → ${key}`, v)).filter((id) => id !== null));
  }

  /** Throws one error listing everything wrong. */
  check(source) {
    if (this.list.length) throw new Error(`${source} has problems:\n  - ${this.list.join('\n  - ')}`);
  }
}

/**
 * Turns one server's raw settings (from guilds.json or the single-server .env variables) into the
 * shape the verifier uses. `where` names the source in error messages.
 */
function guildConfig(guildId, raw, where, p) {
  const optional = { optional: true };
  if (!DISCORD_ID.test(guildId)) p.add(where, `"${guildId}" is not a Discord server id`);
  if (!p.knownKeys(where, raw, GUILD_KEYS)) return null;

  // One role per corp or group of corps/alliances: [{ name, roleId, corporations, alliances }].
  const corpRoles = [];
  if (raw.corpRoles != null && !Array.isArray(raw.corpRoles)) p.add(where, 'corpRoles must be a list [ ... ]');
  (Array.isArray(raw.corpRoles) ? raw.corpRoles : []).forEach((r, i) => {
    const at = `${where} → corpRoles[${i}]${typeof r?.name === 'string' ? ` (${r.name})` : ''}`;
    if (!p.knownKeys(at, r, ['name', 'roleId', 'corporations', 'alliances'])) return;
    const rule = {
      name: r.name || `corpRoles[${i}]`,
      roleId: p.discordId(at, r, 'roleId'),
      corporations: p.eveIds(at, r, 'corporations'),
      alliances: p.eveIds(at, r, 'alliances'),
    };
    if (!rule.corporations.size && !rule.alliances.size) p.add(at, 'list at least one id in corporations or alliances');
    corpRoles.push(rule);
  });

  // Shorthand for one role per alliance: [{ name, allianceId, roleId }]. Several alliances may share a
  // role, and one alliance may earn several roles (e.g. its own role plus a friendlies role).
  const seenAlliances = new Map();
  if (raw.allianceRoles != null && !Array.isArray(raw.allianceRoles)) p.add(where, 'allianceRoles must be a list [ ... ]');
  (Array.isArray(raw.allianceRoles) ? raw.allianceRoles : []).forEach((r, i) => {
    const at = `${where} → allianceRoles[${i}]${typeof r?.name === 'string' ? ` (${r.name})` : ''}`;
    if (!p.knownKeys(at, r, ['name', 'allianceId', 'roleId'])) return;
    const allianceId = p.eveId(`${at} → allianceId`, r.allianceId);
    const roleId = p.discordId(at, r, 'roleId');
    if (allianceId === null) return;
    // Only the same alliance and role twice is a mistake.
    const key = `${allianceId}:${roleId}`;
    if (seenAlliances.has(key)) {
      p.add(at, `alliance ${allianceId} with this role is already listed at allianceRoles[${seenAlliances.get(key)}]`);
      return;
    }
    seenAlliances.set(key, i);
    corpRoles.push({ name: r.name || `allianceRoles[${i}]`, roleId, corporations: new Set(), alliances: new Set([allianceId]) });
  });

  // The original single corp member role. With no corps or alliances listed, everyone qualifies.
  const corpMemberRoleId = p.discordId(where, raw, 'corpMemberRoleId', optional);
  if (corpMemberRoleId) {
    corpRoles.push({
      name: 'corp member',
      roleId: corpMemberRoleId,
      corporations: p.eveIds(where, raw, 'allowedCorporations'),
      alliances: p.eveIds(where, raw, 'allowedAlliances'),
    });
  }

  if (raw.rolesFrom != null && raw.rolesFrom !== '' && !['any', 'main'].includes(raw.rolesFrom)) {
    p.add(where, 'rolesFrom must be "any" or "main"');
  }
  if (raw.setNicknames != null && ![true, false, 'true', 'false', ''].includes(raw.setNicknames)) {
    p.add(where, 'setNicknames must be true or false');
  }
  if (raw.nickFormat != null && typeof raw.nickFormat !== 'string') p.add(where, 'nickFormat must be text');

  return {
    guildId,
    name: raw.name || guildId,

    // Optional: given to anyone with at least one linked character.
    verifiedRoleId: p.discordId(where, raw, 'verifiedRoleId', optional),
    // Each given if a character is in one of the rule's corps or alliances.
    corpRoles,
    // Optional faction warfare roles: given if a character's corp is enlisted with one of the factions.
    // Independent of the corp roles, so allies and other FW pilots get them too.
    militiaRoles: Object.entries(MILITIA_ROLES)
      .map(([key, factions]) => ({ roleId: p.discordId(where, raw, key, optional), factions: new Set(factions) }))
      .filter((r) => r.roleId),
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
  const p = new Problems();
  p.knownKeys(path, parsed, ['guilds']);
  const entries = Object.entries(p.isObject(parsed?.guilds) ? parsed.guilds : {});
  if (!entries.length) p.add(path, 'no servers under "guilds" (see guilds.example.json)');
  const guilds = new Map(entries.map(([id, raw]) => [id, guildConfig(id, raw, `${path} → ${id}`, p)]));
  p.check(path);
  return guilds;
}

/** The original single-server setup, configured entirely from .env. */
function guildFromEnv() {
  if (process.env.MEMBER_ROLE_ID && !process.env.CORP_MEMBER_ROLE_ID) {
    throw new Error('MEMBER_ROLE_ID was renamed to CORP_MEMBER_ROLE_ID; update your .env');
  }
  const guildId = required('GUILD_ID');
  const env = (name) => process.env[name] || undefined;
  const raw = {
    verifiedRoleId: env('VERIFIED_ROLE_ID'),
    corpMemberRoleId: env('CORP_MEMBER_ROLE_ID'),
    allowedCorporations: env('ALLOWED_CORPORATIONS'),
    allowedAlliances: env('ALLOWED_ALLIANCES'),
    amarrMilitiaRoleId: env('AMARR_MILITIA_ROLE_ID'),
    gallenteMilitiaRoleId: env('GALLENTE_MILITIA_ROLE_ID'),
    amarrRoleId: env('AMARR_FACTION_ROLE_ID'),
    caldariRoleId: env('CALDARI_FACTION_ROLE_ID'),
    gallenteRoleId: env('GALLENTE_FACTION_ROLE_ID'),
    minmatarRoleId: env('MINMATAR_FACTION_ROLE_ID'),
    rolesFrom: env('ROLES_FROM'),
    setNicknames: env('SET_NICKNAMES'),
    nickFormat: env('NICK_FORMAT'),
  };
  const p = new Problems();
  const guild = guildConfig(guildId, raw, '.env', p);
  p.check('.env');
  return new Map([[guildId, guild]]);
}

/** Map<guildId, settings>. With GUILDS_FILE set, the single-server variables in .env are ignored. */
export function loadGuilds() {
  return process.env.GUILDS_FILE ? guildsFromFile(process.env.GUILDS_FILE) : guildFromEnv();
}

/**
 * The role manager panel (/manage-roles), or null when MANAGER_GUILD_ID is empty. It serves one
 * server, which must also be one of the bot's servers so its entries become role rules.
 */
function managerFromEnv(guilds, callbackUrl) {
  const guildId = process.env.MANAGER_GUILD_ID;
  if (!guildId) return null;
  const p = new Problems();
  const raw = {
    guildId,
    // Root: full control (Head Of IT). Admin: everything except removing entries and deleting roles (Admins).
    rootRoleId: process.env.MANAGER_ROOT_ROLE_ID || '1556710981512462407',
    adminRoleId: process.env.MANAGER_ADMIN_ROLE_ID || '1437498228273844335',
  };
  for (const key of Object.keys(raw)) p.discordId('.env', raw, key);
  if (!guilds.has(guildId)) p.add('.env', `MANAGER_GUILD_ID ${guildId} must be one of the bot's servers (GUILDS_FILE or GUILD_ID)`);
  p.check('.env');
  return {
    ...raw,
    // Where the panel's links point. Defaults to the host that serves the EVE callback.
    publicUrl: (process.env.PUBLIC_URL || new URL(callbackUrl).origin).replace(/\/+$/, ''),
    // Default name for roles the panel creates. Placeholders: {ticker} {name}.
    roleNameFormat: process.env.ROLE_NAME_FORMAT || '[{ticker}] {name}',
  };
}

const guilds = loadGuilds();
const callbackUrl = required('EVE_CALLBACK_URL');

export const config = {
  discordToken: required('DISCORD_TOKEN'),

  // The servers at startup. The verifier reloads GUILDS_FILE on every sync (see Verifier.reloadGuilds).
  guilds,
  manager: managerFromEnv(guilds, callbackUrl),

  eve: {
    clientId: required('EVE_CLIENT_ID'),
    clientSecret: required('EVE_CLIENT_SECRET'),
    callbackUrl,
  },
  contactEmail: required('CONTACT_EMAIL'),

  webPort: Number(process.env.WEB_PORT || 8080),
  dbPath: process.env.DB_PATH || 'firewatcher-bot.db',
  syncMinutes: Number(process.env.SYNC_MINUTES || 60),
};
