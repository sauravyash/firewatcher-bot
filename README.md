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
- **Role sources.** With `ROLES_FROM=any`, a member qualifies if *any* of their characters is in
  an allowed corp or alliance. This covers the common "my main is in an NPC corp, my alt is in
  ours" case. With `ROLES_FROM=main`, only the main counts.
- **Alts on another EVE account.** The SSO page remembers the last account used. To link an alt
  on a different account, log out on the SSO page first or use a private window.

## Setup

1. **Discord app:** create a bot at <https://discord.com/developers/applications> and copy the
   token. Invite it with the `bot` and `applications.commands` scopes and the
   **Manage Roles** and **Manage Nicknames** permissions. In your server settings, drag the bot's
   role **above** the roles it hands out. It can't rename the server owner or anyone above it.
2. **EVE app:** create an application at <https://developers.eveonline.com/applications> with the
   `publicData` scope. Set its callback URL to your `EVE_CALLBACK_URL`.
3. **Config:** `cp .env.example .env` and fill it in. To get Discord ids, turn on
   Developer Mode in Discord, then right-click a server or role and choose **Copy ID**.
4. Run:

   ```bash
   npm install
   npm start
   ```

The callback server must be reachable from the member's browser. `localhost` works while you
test it yourself. For real use, see [deploy/README.md](deploy/README.md) to host it for free on
Google Cloud behind a Cloudflare Tunnel.

Requires Node 22.13+ (it uses the built-in `node:sqlite`).
