function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

// Server ids and roles moved from .env to settings.json; catch old setups instead of silently ignoring them.
const MOVED = [
  'GUILD_ID', 'VERIFIED_ROLE_ID', 'CORP_MEMBER_ROLE_ID', 'MEMBER_ROLE_ID', 'ALLOWED_CORPORATIONS', 'ALLOWED_ALLIANCES',
  'AMARR_MILITIA_ROLE_ID', 'GALLENTE_MILITIA_ROLE_ID', 'ROLES_FROM', 'SET_NICKNAMES', 'NICK_FORMAT',
].filter((name) => process.env[name]);
if (MOVED.length) {
  throw new Error(`${MOVED.join(', ')} moved from .env to settings.json (see settings.example.json); remove them from .env`);
}

/** Secrets and runtime options. Server ids and roles live in settings.json (see settings.js). */
export const config = {
  discordToken: required('DISCORD_TOKEN'),
  settingsFile: process.env.SETTINGS_FILE || 'settings.json',

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
