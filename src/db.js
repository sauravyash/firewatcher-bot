import { DatabaseSync } from 'node:sqlite';

const PENDING_TTL_SECONDS = 10 * 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS characters (
  character_id   INTEGER PRIMARY KEY,
  discord_id     TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  owner_hash     TEXT    NOT NULL,
  corporation_id INTEGER,
  alliance_id    INTEGER,
  is_main        INTEGER NOT NULL DEFAULT 0,
  linked_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_discord ON characters (discord_id);

CREATE TABLE IF NOT EXISTS pending_logins (
  state      TEXT PRIMARY KEY,
  discord_id TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Role manager: alliances and corps on a server, each optionally tied to a Discord role.
-- One alliance or corp may appear more than once with different roles.
CREATE TABLE IF NOT EXISTS role_entries (
  id              INTEGER PRIMARY KEY,
  guild_id        TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('alliance', 'corporation')),
  eve_id          INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  ticker          TEXT    NOT NULL,
  alliance_id     INTEGER,
  role_id         TEXT,
  notes           TEXT    NOT NULL DEFAULT '',
  suggest_corps   INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT    NOT NULL,
  updated_by_name TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_role_entries_unique ON role_entries (guild_id, kind, eve_id, IFNULL(role_id, ''));

CREATE TABLE IF NOT EXISTS role_log (
  id         INTEGER PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  actor_id   TEXT    NOT NULL,
  actor_name TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  summary    TEXT    NOT NULL
);

-- Single-use links that /manage-roles hands out.
CREATE TABLE IF NOT EXISTS panel_links (
  token      TEXT PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  discord_id TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  // --- SSO login state (ties an EVE login back to the Discord user who asked for it) ---

  addPending(state, discordId) {
    this.db.prepare('DELETE FROM pending_logins WHERE created_at < ?').run(now() - PENDING_TTL_SECONDS);
    this.db
      .prepare('INSERT INTO pending_logins (state, discord_id, created_at) VALUES (?, ?, ?)')
      .run(state, discordId, now());
  }

  /** Single use: returns the Discord id for a valid state and deletes it. */
  popPending(state) {
    const row = this.db.prepare('SELECT discord_id, created_at FROM pending_logins WHERE state = ?').get(state);
    if (!row) return null;
    this.db.prepare('DELETE FROM pending_logins WHERE state = ?').run(state);
    if (row.created_at < now() - PENDING_TTL_SECONDS) return null;
    return row.discord_id;
  }

  // --- Characters ---

  getCharacter(characterId) {
    return this.db.prepare('SELECT * FROM characters WHERE character_id = ?').get(characterId);
  }

  findCharacterByName(name) {
    return this.db.prepare('SELECT * FROM characters WHERE name = ? COLLATE NOCASE').get(name);
  }

  /** Main first, then alts alphabetically. */
  charactersFor(discordId) {
    return this.db
      .prepare('SELECT * FROM characters WHERE discord_id = ? ORDER BY is_main DESC, name')
      .all(discordId);
  }

  allCharacters() {
    return this.db.prepare('SELECT * FROM characters').all();
  }

  allDiscordIds() {
    return this.db.prepare('SELECT DISTINCT discord_id FROM characters').all().map((r) => r.discord_id);
  }

  /** Links (or re-links) a character. The first character a user links becomes their main. */
  upsertCharacter({ discordId, characterId, name, ownerHash, corporationId, allianceId }) {
    const hasOtherMain = this.db
      .prepare('SELECT 1 FROM characters WHERE discord_id = ? AND is_main = 1 AND character_id != ?')
      .get(discordId, characterId);
    this.db
      .prepare(
        `INSERT INTO characters
           (character_id, discord_id, name, owner_hash, corporation_id, alliance_id, is_main, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (character_id) DO UPDATE SET
           discord_id = excluded.discord_id,
           name = excluded.name,
           owner_hash = excluded.owner_hash,
           corporation_id = excluded.corporation_id,
           alliance_id = excluded.alliance_id,
           is_main = excluded.is_main`,
      )
      .run(characterId, discordId, name, ownerHash, corporationId, allianceId, hasOtherMain ? 0 : 1, now());
  }

  setMain(discordId, characterId) {
    const owned = this.db
      .prepare('SELECT 1 FROM characters WHERE discord_id = ? AND character_id = ?')
      .get(discordId, characterId);
    if (!owned) return false;
    this.db
      .prepare('UPDATE characters SET is_main = (character_id = ?) WHERE discord_id = ?')
      .run(characterId, discordId);
    return true;
  }

  removeCharacter(discordId, characterId) {
    const { changes } = this.db
      .prepare('DELETE FROM characters WHERE discord_id = ? AND character_id = ?')
      .run(discordId, characterId);
    this.ensureMain(discordId);
    return changes > 0;
  }

  /** If a user lost their main (unlinked or transferred away), promote their oldest alt. */
  ensureMain(discordId) {
    const hasMain = this.db.prepare('SELECT 1 FROM characters WHERE discord_id = ? AND is_main = 1').get(discordId);
    if (hasMain) return;
    this.db
      .prepare(
        `UPDATE characters SET is_main = 1 WHERE character_id = (
           SELECT character_id FROM characters WHERE discord_id = ? ORDER BY linked_at LIMIT 1)`,
      )
      .run(discordId);
  }

  updateAffiliation(characterId, corporationId, allianceId) {
    this.db
      .prepare('UPDATE characters SET corporation_id = ?, alliance_id = ? WHERE character_id = ?')
      .run(corporationId, allianceId, characterId);
  }

  // --- Role manager sign-in links (same single-use pattern as the SSO state) ---

  addPanelLink(token, guildId, discordId) {
    this.db.prepare('DELETE FROM panel_links WHERE created_at < ?').run(now() - PENDING_TTL_SECONDS);
    this.db
      .prepare('INSERT INTO panel_links (token, guild_id, discord_id, created_at) VALUES (?, ?, ?, ?)')
      .run(token, guildId, discordId, now());
  }

  /** Single use: returns { guildId, discordId } for a valid link and deletes it. */
  popPanelLink(token) {
    const row = this.db.prepare('SELECT * FROM panel_links WHERE token = ?').get(token);
    if (!row) return null;
    this.db.prepare('DELETE FROM panel_links WHERE token = ?').run(token);
    if (row.created_at < now() - PENDING_TTL_SECONDS) return null;
    return { guildId: row.guild_id, discordId: row.discord_id };
  }

  // --- Role manager entries ---

  roleEntries(guildId) {
    return this.db.prepare('SELECT * FROM role_entries WHERE guild_id = ? ORDER BY name COLLATE NOCASE').all(guildId);
  }

  roleEntry(guildId, id) {
    return this.db.prepare('SELECT * FROM role_entries WHERE guild_id = ? AND id = ?').get(guildId, id);
  }

  findRoleEntry(guildId, kind, eveId, roleId) {
    return this.db
      .prepare("SELECT * FROM role_entries WHERE guild_id = ? AND kind = ? AND eve_id = ? AND IFNULL(role_id, '') = ?")
      .get(guildId, kind, eveId, roleId ?? '');
  }

  addRoleEntry(guildId, { kind, eveId, name, ticker, allianceId, roleId, notes, suggestCorps }, actor) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO role_entries (guild_id, kind, eve_id, name, ticker, alliance_id, role_id, notes, suggest_corps,
           created_at, updated_at, updated_by, updated_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(guildId, kind, eveId, name, ticker, allianceId ?? null, roleId ?? null, notes ?? '',
        suggestCorps === false ? 0 : 1, now(), now(), actor.id, actor.name);
    return this.roleEntry(guildId, Number(lastInsertRowid));
  }

  /** Updates the given fields and stamps who changed the entry. */
  updateRoleEntry(guildId, id, fields, actor) {
    const columns = {
      roleId: 'role_id', notes: 'notes', suggestCorps: 'suggest_corps', name: 'name', ticker: 'ticker', allianceId: 'alliance_id',
    };
    const keys = Object.keys(fields).filter((k) => k in columns);
    const values = keys.map((k) => (k === 'suggestCorps' ? (fields[k] ? 1 : 0) : fields[k]));
    this.db
      .prepare(
        `UPDATE role_entries SET ${keys.map((k) => `${columns[k]} = ?, `).join('')}
           updated_at = ?, updated_by = ?, updated_by_name = ?
         WHERE guild_id = ? AND id = ?`,
      )
      .run(...values, now(), actor.id, actor.name, guildId, id);
    return this.roleEntry(guildId, id);
  }

  removeRoleEntry(guildId, id) {
    return this.db.prepare('DELETE FROM role_entries WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;
  }

  /** Entries pointing at a role, other than the one given. */
  entriesUsingRole(guildId, roleId, exceptId = null) {
    return this.db
      .prepare('SELECT * FROM role_entries WHERE guild_id = ? AND role_id = ? AND id IS NOT ?')
      .all(guildId, roleId, exceptId);
  }

  logRoleAction(guildId, actor, action, summary) {
    this.db
      .prepare('INSERT INTO role_log (guild_id, at, actor_id, actor_name, action, summary) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, now(), actor.id, actor.name, action, summary);
  }

  roleLog(guildId, limit = 40) {
    return this.db.prepare('SELECT * FROM role_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guildId, limit);
  }
}
