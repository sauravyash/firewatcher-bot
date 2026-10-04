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

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  guildId: required('GUILD_ID'),

  // Given to anyone with at least one linked character.
  verifiedRoleId: required('VERIFIED_ROLE_ID'),
  // Optional: given only if a character is in an allowed corp/alliance.
  memberRoleId: process.env.MEMBER_ROLE_ID || null,
  allowedCorporations: idSet('ALLOWED_CORPORATIONS'),
  allowedAlliances: idSet('ALLOWED_ALLIANCES'),
  // "any": member role if ANY linked character qualifies. "main": only the main counts.
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
