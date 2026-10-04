function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

function idSet(name) {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
}

// EVE faction ids. Faction warfare pairs them into two warzone sides.
const CALDARI_STATE = 500001;
const MINMATAR_REPUBLIC = 500002;
const AMARR_EMPIRE = 500003;
const GALLENTE_FEDERATION = 500004;

if (process.env.MEMBER_ROLE_ID && !process.env.CORP_MEMBER_ROLE_ID) {
  throw new Error('MEMBER_ROLE_ID was renamed to CORP_MEMBER_ROLE_ID; update your .env');
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  guildId: required('GUILD_ID'),

  // Given to anyone with at least one linked character.
  verifiedRoleId: required('VERIFIED_ROLE_ID'),
  // Optional: given only if a character is in an allowed corp/alliance.
  corpMemberRoleId: process.env.CORP_MEMBER_ROLE_ID || null,
  allowedCorporations: idSet('ALLOWED_CORPORATIONS'),
  allowedAlliances: idSet('ALLOWED_ALLIANCES'),
  // Optional faction warfare roles: given if a character's corp is enlisted with that side's militia.
  // Independent of the corp member role, so allies and other FW pilots get them too.
  militiaRoles: [
    { roleId: process.env.AMARR_MILITIA_ROLE_ID, factions: new Set([AMARR_EMPIRE, CALDARI_STATE]) },
    { roleId: process.env.GALLENTE_MILITIA_ROLE_ID, factions: new Set([GALLENTE_FEDERATION, MINMATAR_REPUBLIC]) },
  ].filter((r) => r.roleId),
  // "any": a role applies if ANY linked character qualifies. "main": only the main counts.
  rolesFrom: process.env.ROLES_FROM === 'main' ? 'main' : 'any',

  setNicknames: process.env.SET_NICKNAMES !== 'false',
  // Placeholders: {name} {corp} {alliance}. Empty [] brackets are stripped.
  nickFormat: process.env.NICK_FORMAT || '[{corp}] {name}',

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
