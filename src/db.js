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
}
