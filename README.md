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

## Servers and roles

The bot can serve several Discord servers. Members link characters once, and each server applies
its own role rules. Put the servers in a JSON file and point `GUILDS_FILE` at it in `.env`.
Start from [guilds.example.json](guilds.example.json):

```json
{
  "guilds": {
    "111111111111111111": {
      "name": "Main corp server",
      "verifiedRoleId": "222222222222222222",
      "corpRoles": [
        { "name": "Our corp", "roleId": "333333333333333333", "corporations": [98000001] }
      ],
      "allianceRoles": [
        { "name": "Friendly alliance", "allianceId": 99000002, "roleId": "101010101010101010" }
      ],
      "amarrMilitiaRoleId": "444444444444444444",
      "caldariRoleId": "555555555555555555"
    }
  }
}
```

| Field (per server) | Given to |
|---|---|
| `verifiedRoleId` | Anyone with at least one linked character |
| `corpRoles` | One role per rule: `{ name, roleId, corporations: [...], alliances: [...] }`. Members with a character in any listed corp or alliance |
| `allianceRoles` | Shorthand for one role per alliance: `{ name, allianceId, roleId }`. Several alliances can share a role, and one alliance can have several roles (e.g. its own role plus a friendlies role). People in unlisted alliances get none |
| `amarrMilitiaRoleId` | Members with a character whose corp is enlisted with the **Amarr or Caldari** militia |
| `gallenteMilitiaRoleId` | Members with a character whose corp is enlisted with the **Gallente or Minmatar** militia |
| `amarrRoleId`, `caldariRoleId`, `gallenteRoleId`, `minmatarRoleId` | Members with a character whose corp is enlisted with that one faction's militia |
| `corpMemberRoleId` + `allowedCorporations` / `allowedAlliances` | The original single corp member role. With both lists empty, every verified character qualifies |

Other per-server fields: `name` (a label for logs), `rolesFrom` (`"any"` or `"main"`, see
[How alts work](#how-alts-work)), `setNicknames` (`true`/`false`) and `nickFormat`
(placeholders `{name}` `{corp}` `{alliance}`; Discord truncates at 32 characters). Every role is optional.

- **Discord ids** (server and role ids) must be **in quotes**. They're too long for plain JSON
  numbers, which would round them.
- **EVE ids** (corps, alliances) are plain numbers. They're the number in the zKillboard or EVE Who URL.
- `name` fields are labels for you. The bot doesn't match on them.

The bot checks the whole file and lists every mistake at once: invalid JSON, unknown or misspelled
fields, unquoted or malformed ids, and the same alliance listed twice for one role. At startup, a bad
file stops the bot, so check it after editing with `npm run check-config`.
The file is **reloaded on every sync**, so after editing it, run `/resync` (or wait for the next
sync) instead of restarting. If an edit has a mistake, the bot logs it and keeps using the last good
settings. Adding or removing a server needs a restart.

Several rules can point at the same Discord role. A member gets it if any of them match. Roles are
removed when a member no longer qualifies. The bot syncs everyone at startup, so new settings reach
existing members right away.

Militia roles are separate from the corp roles, so a member can hold both, and allied FW pilots
outside your corp get a militia role too. Militia membership comes from the character's public
`faction_id` in ESI, so pilots who enlist on their own inside a player corp count. If the character
has none, the corp's `faction_id` is used (enlisted corps and NPC militia corps like 24th Imperial
Crusade or Federal Defense Union). No extra EVE permissions are needed.

**Single server without a file:** leave `GUILDS_FILE` empty and set `GUILD_ID`, `VERIFIED_ROLE_ID`
and the other role variables in `.env` instead (see [.env.example](.env.example)). `allianceRoles`
and `corpRoles` need the file.

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
| `/post-verify` | Manage Roles | Post a "Verify with EVE Online" button in the current channel. Each click gives that member their own private login link, the same as `/verify`. The bot needs View Channel, Send Messages and Embed Links there. |
| `/manage-roles` | Panel root and admin | Open the [role manager panel](#role-manager-panel) (only on `MANAGER_GUILD_ID`) |

## Role manager panel

Server staff can manage the alliance and corp roles in a web panel instead of editing
`guilds.json`. Set `MANAGER_GUILD_ID` in `.env` to turn it on for one server (see
[.env.example](.env.example)), then run `/manage-roles` there. Staff get a private, single-use link
(valid 10 minutes) that signs them in for 12 hours. Anyone else is refused.

| | Root | Admin |
|---|---|---|
| View the list, recommendations and change log | ✓ | ✓ |
| Add alliances and corps, link or create their role | ✓ | ✓ |
| Edit notes, relink, rename/recolour/hoist/mentionable the linked role | ✓ | ✓ |
| Remove entries, delete their Discord role | ✓ | |

Access comes from the `MANAGER_ROOT_ROLE_ID` (Head Of IT) and `MANAGER_ADMIN_ROLE_ID` (Admins) roles and is re-checked with
Discord at least once a minute, so taking the role away locks someone out straight away.

- **Entries are role rules.** Each alliance or corp in the panel works like an `allianceRoles` or
  `corpRoles` rule: the bot gives its role to verified members with a character there. Changes reach
  members in a sync about 30 seconds later. Several entries can share a role, and an alliance can be
  listed more than once with different roles. Rules still in `guilds.json` keep working and are shown
  read-only in the panel.
- **Removing an entry** stops the bot handing out its role, but members who have it keep it. Tick
  "also delete the Discord role" to remove it from everyone (only allowed if nothing else uses it).
- **Recommendations** come from ESI's member list of each listed alliance (the same data DOTLAN shows,
  refreshed about hourly): corps that joined but aren't listed yet, with one-click "Add with new role"
  (in the alliance role's colour), and listed corps that left. Untick "Recommend new member corps" on
  friendly alliances you don't want per-corp roles for.
- **Member list order.** Discord groups the member list by each member's highest hoisted role. The
  panel lists the hoisted roles in order and lets root and admin move them up and down. Only the
  roles the panel may touch move, and they swap among the positions they already hold, so staff
  roles, the bot's role, roles with moderation permissions (kick, ban, timeout, manage nicknames)
  and non-hoisted roles keep their exact place.
- **Safety.** New roles have no permissions, and edits only change name, colour, hoist and
  mentionable. The panel won't link or change @everyone, the root and admin roles, bot-managed
  roles, roles with Administrator, Manage Server or Manage Roles, or roles at or above the bot's own.
  Every change carries an audit-log reason naming the staff member.

To move the existing rules for that server from `guilds.json` into the panel, run
`npm run import-roles` (shows what it would do) and then `npm run import-roles -- --apply`. Check the
panel, then delete that server's `corpRoles` and `allianceRoles` from `guilds.json`.

## How alts work

- **One character, one Discord account.** If someone tries to link a character that's already
  linked to another Discord account, the bot refuses.
- **Sold characters change hands automatically.** Each SSO login includes an *owner hash* that
  changes when a character is transferred to another EVE account. If a character comes back with
  a new owner hash, the new owner takes it over, and the old owner loses it (they get a new main
  if needed).
- **Role sources.** With `"rolesFrom": "any"`, a member qualifies if *any* of their characters is in
  an allowed corp or alliance. This covers the common "my main is in an NPC corp, my alt is in
  ours" case. With `"main"`, only the main counts. This applies to the corp, alliance
  and militia roles too: with `any`, someone with alts in both militias gets both roles. Use `/whois` to spot that.
- **Alts on another EVE account.** The SSO page remembers the last account used. To link an alt
  on a different account, log out on the SSO page first or use a private window.

## Terms and privacy

The bot serves a Terms of Service at `/terms` and a Privacy Policy at `/privacy` on the same address as
the EVE callback (e.g. `https://firewatcher-bot.yaa.sh/terms`). Put those URLs in the Discord developer
portal under **General Information**. Both show `CONTACT_EMAIL` as the contact. If you change what the
bot stores, update [src/legal.js](src/legal.js) to match.

## Setup

1. **Discord app:** create a bot at <https://discord.com/developers/applications> and copy the
   token. Invite it with the `bot` and `applications.commands` scopes and the
   **Manage Roles** and **Manage Nicknames** permissions. In your server settings, drag the bot's
   role **above** the roles it hands out. It can't rename the server owner or anyone above it.
2. **EVE app:** create an application at <https://developers.eveonline.com/applications> with the
   `publicData` scope. Set its callback URL to your `EVE_CALLBACK_URL`.
3. **Config:** `cp .env.example .env` and `cp guilds.example.json guilds.json`, then fill
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
