# firewatcher-bot

A Discord bot that verifies members by having them log in through **EVE Online SSO**. It supports
alts: each Discord member can link any number of characters, one of which is their **main**.
The main sets their server nickname, and their roles come from their characters' corp and alliance.

## How it works

1. A member runs `/verify` and gets a private "Log in with EVE Online" button.
2. They log in on `login.eveonline.com` and pick a character.
3. EVE redirects to the bot's `/callback`. The bot checks the signed token from CCP, so the
   character is proven, not typed in, then looks up its corp and alliance through ESI.
4. The bot gives roles and sets the nickname from the main, for example `[CORP] Main Name`.
5. Every `SYNC_MINUTES` minutes, the bot re-checks every character's corp and alliance in one bulk
   ESI call and updates roles. This handles people who leave the corp, and it resets nicknames
   that someone changed by hand.

The bot stores no refresh tokens. Each SSO login is used once, to prove identity, and then
discarded.

## Settings

Secrets (Discord token, EVE app keys) and runtime options go in `.env`. Everything else goes in
`settings.json` next to it: the server id, the roles, and the corps and alliances. Start by
copying [settings.example.json](settings.example.json). Set `SETTINGS_FILE` in `.env` to use a
different path.

```json
{
  "guildId": "123456789012345678",
  "roles": {
    "verified": "123456789012345678",
    "corpMember": null,
    "amarrMilitia": null, "gallenteMilitia": null,
    "amarr": null, "caldari": null, "gallente": null, "minmatar": null
  },
  "rolesFrom": "any",
  "allowedCorporations": [{ "name": "Example Corp", "id": 98000001 }],
  "allowedAlliances": [],
  "allianceRoles": [
    { "name": "Example Alliance", "allianceId": 99000001, "roleId": "123456789012345678" }
  ],
  "nicknames": { "enabled": true, "format": "[{corp}] {name}" }
}
```

- **Discord ids** (`guildId`, role ids) must be **in quotes**. They're too long for plain JSON
  numbers, which would round them. Use `null` (or leave the field out) for a role you don't want.
- **EVE ids** (corps, alliances) are plain numbers. They're the number in the zKillboard or EVE Who URL.
- `name` fields are labels for you. The bot ignores them. `allowedCorporations` and
  `allowedAlliances` also accept bare ids: `[98000001, 98000002]`.
- `rolesFrom` is `"any"` or `"main"`; see [How alts work](#how-alts-work).
- Nickname placeholders: `{name}` `{corp}` `{alliance}`. Discord truncates at 32 characters.

The bot checks the whole file and lists every mistake at once: bad JSON, unknown or misspelled
fields, unquoted or malformed ids, and duplicates. At startup, a bad file stops the bot.
The file is **reloaded on every sync**, so after editing it, run `/resync` (or wait for the next
sync) instead of restarting. If an edit has a mistake, the bot logs it and keeps using the last
good version. Changing `guildId` needs a restart.

## Roles

| `roles.` / setting | Given to |
|---|---|
| `verified` | Anyone with at least one linked character |
| `corpMember` | Members with a character in `allowedCorporations` or `allowedAlliances` (if both lists are empty, every verified character counts) |
| `amarrMilitia` | Members with a character whose corp is enlisted with the **Amarr or Caldari** militia |
| `gallenteMilitia` | Members with a character whose corp is enlisted with the **Gallente or Minmatar** militia |
| `amarr`, `caldari`, `gallente`, `minmatar` | Members with a character whose corp is enlisted with that one faction's militia |
| `allianceRoles` | Members with a character in a listed alliance get that alliance's role. People in unlisted alliances get none |

Militia roles are separate from the corp member role, so a member can hold both, and allied
FW pilots outside your corp get a militia role too. Militia membership comes from the
corporation's public `faction_id` in ESI. That includes the NPC militia corps solo pilots join,
like 24th Imperial Crusade or Federal Defense Union. No extra EVE permissions are needed.

Several settings can point at the same Discord role (for example, two alliances sharing one
role). A member gets it if any of them match. Roles are removed when a member no longer
qualifies. The bot syncs everyone at startup, so new settings reach existing members right away.

## Commands

| Command | Who | What |
|---|---|---|
| `/verify` | everyone | Link a character. Run it again for each alt. |
| `/characters` | everyone | List your linked characters (★ = main) |
| `/setmain <character>` | everyone | Choose which character sets your nickname |
| `/unlink <character>` | everyone | Remove a character. If it was your main, your oldest alt becomes main. |
| `/whois @member` | Manage Roles | All characters linked to a member |
| `/whochar <name>` | Manage Roles | Which member owns a character |
| `/resync` | Manage Roles | Force a full refresh now |

## How alts work

- **One character, one Discord account.** If someone tries to link a character that's already
  linked to another Discord account, the bot refuses.
- **Sold characters change hands automatically.** Each SSO login includes an *owner hash* that
  changes when a character is transferred to another EVE account. If a character comes back with
  a new owner hash, the new owner takes it over, and the old owner loses it (they get a new main
  if needed).
- **Role sources.** With `"rolesFrom": "any"`, a member qualifies if *any* of their characters is in
  an allowed corp or alliance. This covers the common "my main is in an NPC corp, my alt is in
  ours" case. With `"main"`, only the main counts. This applies to the militia,
  faction and alliance roles too: with `any`, someone with alts in both militias gets both roles. Use `/whois` to spot that.
- **Alts on another EVE account.** The SSO page remembers the last account used. To link an alt
  on a different account, log out on the SSO page first or use a private window.

## Setup

1. **Discord app:** create a bot at <https://discord.com/developers/applications> and copy the
   token. Invite it with the `bot` and `applications.commands` scopes and the
   **Manage Roles** and **Manage Nicknames** permissions. In your server settings, drag the bot's
   role **above** the roles it hands out. It can't rename the server owner or anyone above it.
2. **EVE app:** create an application at <https://developers.eveonline.com/applications> with the
   `publicData` scope. Set its callback URL to your `EVE_CALLBACK_URL`.
3. **Config:** `cp .env.example .env` and `cp settings.example.json settings.json`, then fill
   both in. To get Discord ids, turn on
   Developer Mode in Discord, then right-click a server or role and choose **Copy ID**.
4. Run:

   ```bash
   npm install
   npm start
   ```

The callback server must be reachable from the member's browser. `localhost` works while you
test it yourself. For real use, see [deploy/README.md](deploy/README.md) to run it in an LXC
container (or any Debian/Ubuntu machine) behind a Cloudflare Tunnel.

Requires Node 22.13+ (it uses the built-in `node:sqlite`).
