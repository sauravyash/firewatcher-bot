import { readFileSync } from 'node:fs';

// EVE faction ids. Faction warfare pairs them into two warzone sides.
const CALDARI_STATE = 500001;
const MINMATAR_REPUBLIC = 500002;
const AMARR_EMPIRE = 500003;
const GALLENTE_FEDERATION = 500004;

const ROLE_KEYS = {
  verified: null,
  corpMember: null,
  amarrMilitia: [AMARR_EMPIRE, CALDARI_STATE],
  gallenteMilitia: [GALLENTE_FEDERATION, MINMATAR_REPUBLIC],
  amarr: [AMARR_EMPIRE],
  caldari: [CALDARI_STATE],
  gallente: [GALLENTE_FEDERATION],
  minmatar: [MINMATAR_REPUBLIC],
};

/** Collects every problem in the file so a bad edit can be fixed in one pass. */
class Checker {
  errors = [];

  fail(path, message) {
    this.errors.push(`${path}: ${message}`);
  }

  isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  object(path, value, keys) {
    if (!this.isObject(value)) {
      this.fail(path, 'must be an object { ... }');
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) this.fail(path, `unknown field "${key}" (expected one of: ${keys.join(', ')})`);
    }
    return value;
  }

  /** Discord ids are too big for JSON numbers to hold exactly, so they must be quoted. */
  discordId(path, value, { optional = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (!optional) this.fail(path, 'is required');
      return null;
    }
    if (typeof value === 'number') {
      this.fail(path, `must be in quotes (${value} may already be rounded; copy the id from Discord again)`);
      return null;
    }
    if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
      this.fail(path, 'must be a Discord id in quotes, like "123456789012345678"');
      return null;
    }
    return value;
  }

  eveId(path, value) {
    const id = Number(value);
    if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(id) || id === 0) {
      this.fail(path, 'must be an EVE id (a whole number)');
      return null;
    }
    return id;
  }

  label(path, value) {
    if (value !== undefined && typeof value !== 'string') this.fail(path, 'must be text');
  }

  /** A list of EVE ids, each either a bare number or { "name": ..., "id": ... }. */
  eveIdList(path, value) {
    if (value === undefined) return new Set();
    if (!Array.isArray(value)) {
      this.fail(path, 'must be a list [ ... ]');
      return new Set();
    }
    const ids = new Set();
    value.forEach((entry, i) => {
      const at = `${path}[${i}]${typeof entry?.name === 'string' ? ` (${entry.name})` : ''}`;
      let id;
      if (this.isObject(entry)) {
        this.object(at, entry, ['name', 'id']);
        this.label(`${at}.name`, entry.name);
        id = this.eveId(`${at}.id`, entry.id);
      } else {
        id = this.eveId(at, entry);
      }
      if (id === null) return;
      if (ids.has(id)) this.fail(at, `${id} is listed twice`);
      ids.add(id);
    });
    return ids;
  }
}

/**
 * Reads and validates the server settings file. Throws one error listing every problem.
 * IDs that are not secret live here rather than in .env so long lists stay readable.
 */
export function loadSettings(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${path} not found. Copy settings.example.json to ${path} and fill it in.`);
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  const c = new Checker();
  const s = c.object('settings', raw, [
    'guildId', 'roles', 'rolesFrom', 'allowedCorporations', 'allowedAlliances', 'allianceRoles', 'nicknames',
  ]);

  const roles = c.object('roles', s.roles ?? {}, Object.keys(ROLE_KEYS));
  const roleId = (key) => c.discordId(`roles.${key}`, roles[key], { optional: key !== 'verified' });

  if (s.rolesFrom !== undefined && !['any', 'main'].includes(s.rolesFrom)) {
    c.fail('rolesFrom', 'must be "any" or "main"');
  }

  const nicknames = c.object('nicknames', s.nicknames ?? {}, ['enabled', 'format']);
  if (nicknames.enabled !== undefined && typeof nicknames.enabled !== 'boolean') {
    c.fail('nicknames.enabled', 'must be true or false (no quotes)');
  }
  if (nicknames.format !== undefined && typeof nicknames.format !== 'string') c.fail('nicknames.format', 'must be text');

  const allianceRoles = [];
  const seenAlliances = new Map();
  if (s.allianceRoles !== undefined && !Array.isArray(s.allianceRoles)) {
    c.fail('allianceRoles', 'must be a list [ ... ]');
  } else {
    (s.allianceRoles ?? []).forEach((entry, i) => {
      const at = `allianceRoles[${i}]${typeof entry?.name === 'string' ? ` (${entry.name})` : ''}`;
      c.object(at, entry, ['name', 'allianceId', 'roleId']);
      c.label(`${at}.name`, entry?.name);
      const allianceId = c.eveId(`${at}.allianceId`, entry?.allianceId);
      const role = c.discordId(`${at}.roleId`, entry?.roleId);
      if (allianceId !== null && seenAlliances.has(allianceId)) {
        c.fail(at, `alliance ${allianceId} is already listed at allianceRoles[${seenAlliances.get(allianceId)}]`);
      } else if (allianceId !== null) {
        seenAlliances.set(allianceId, i);
      }
      if (allianceId !== null && role !== null) allianceRoles.push({ name: entry.name ?? '', allianceId, roleId: role });
    });
  }

  const settings = {
    guildId: c.discordId('guildId', s.guildId),
    // Given to anyone with at least one linked character.
    verifiedRoleId: roleId('verified'),
    // Optional: given only if a character is in an allowed corp/alliance.
    corpMemberRoleId: roleId('corpMember'),
    allowedCorporations: c.eveIdList('allowedCorporations', s.allowedCorporations),
    allowedAlliances: c.eveIdList('allowedAlliances', s.allowedAlliances),
    // Optional faction warfare roles: given if a character's corp is enlisted with one of the factions.
    // Independent of the corp member role, so allies and other FW pilots get them too.
    militiaRoles: Object.entries(ROLE_KEYS)
      .filter(([, factions]) => factions)
      .map(([key, factions]) => ({ roleId: roleId(key), factions: new Set(factions) }))
      .filter((r) => r.roleId),
    // Optional per-alliance roles: given if a character is in that alliance.
    allianceRoles,
    // "any": a role applies if ANY linked character qualifies. "main": only the main counts.
    rolesFrom: s.rolesFrom === 'main' ? 'main' : 'any',
    setNicknames: nicknames.enabled !== false,
    // Placeholders: {name} {corp} {alliance}. Empty [] brackets are stripped.
    nickFormat: nicknames.format || '[{corp}] {name}',
  };

  if (c.errors.length) throw new Error(`${path} has problems:\n  - ${c.errors.join('\n  - ')}`);
  return settings;
}
