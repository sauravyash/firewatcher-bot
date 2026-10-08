// Terms of Service and Privacy Policy pages, linked from the bot's Discord application settings.
// Keep the privacy policy in step with what db.js actually stores.

const UPDATED = '8 October 2026';

export function termsPage({ contactEmail }) {
  return page('Terms of Service', `
<p>These terms cover firewatcher-bot ("the bot"), a Discord bot that links Discord accounts to EVE Online
characters and manages roles on the Discord servers it's added to. By using the bot's commands or its web
pages, you agree to these terms.</p>

<h2>What the bot does</h2>
<ul>
  <li>Lets you link EVE Online characters to your Discord account by logging in through EVE Online's official
    login (EVE SSO).</li>
  <li>Gives you Discord roles and sets your server nickname from your characters' corporation, alliance and
    faction warfare enlistment, and keeps them up to date.</li>
  <li>Lets server staff look up which characters a member has linked, and manage which alliances and
    corporations get which roles.</li>
</ul>

<h2>Your responsibilities</h2>
<ul>
  <li>Only link characters you own. Don't try to link someone else's character, get around a server's
    verification, or interfere with the bot.</li>
  <li>Follow <a href="https://discord.com/terms">Discord's Terms of Service</a> and
    <a href="https://www.eveonline.com/eula">CCP's EVE Online EULA</a>.</li>
  <li>Server staff with access to staff commands or the role manager must use what they see only to run
    their server.</li>
</ul>

<h2>Server rules come first</h2>
<p>Each Discord server decides who gets which roles and who may use the bot. Server staff can remove
roles, remove access, or remove the bot at any time. Questions about a server's roles go to that server's
staff.</p>

<h2>No warranty</h2>
<p>The bot is a free community tool, provided as is, without any warranty. It may be changed, be
unavailable or stop at any time. Roles and nicknames depend on EVE Online's public data, which can be
delayed or wrong. To the extent the law allows, the operators aren't liable for any loss from using or
being unable to use the bot.</p>

<h2>Not affiliated with CCP or Discord</h2>
<p>firewatcher-bot is not made, endorsed or supported by CCP Games or Discord. EVE Online and all related
names are trademarks of CCP hf.</p>

<h2>Changes and contact</h2>
<p>These terms may be updated; the date below shows the latest version. Continuing to use the bot means
you accept the update. Questions: <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>
`);
}

export function privacyPage({ contactEmail }) {
  return page('Privacy Policy', `
<p>This policy explains what firewatcher-bot ("the bot") stores about you, why, and how to have it
removed. The bot keeps as little as it needs to give you the right Discord roles.</p>

<h2>What the bot stores</h2>
<table>
  <tr><th>Data</th><th>Why</th><th>How long</th></tr>
  <tr><td>Your Discord user id, and for each EVE character you link: its character id and name, its
    corporation and alliance, which character is your main, and when you linked it</td>
    <td>To give you roles and a nickname, and to let server staff see who owns which character</td>
    <td>Until you unlink the character</td></tr>
  <tr><td>The EVE "owner hash" for each linked character</td>
    <td>To notice when a character is sold or transferred to another EVE account, so the new owner can take
    it over</td><td>Until you unlink the character</td></tr>
  <tr><td>A short random code tying an EVE login (or a staff sign-in link) to your Discord account</td>
    <td>To finish the login you started</td><td>Deleted when used, or after 10 minutes</td></tr>
  <tr><td>For server staff using the role manager: your Discord id and display name next to the changes you
    make</td><td>So staff can see who changed what</td><td>Kept with the server's role settings</td></tr>
</table>

<h2>What the bot does not store</h2>
<ul>
  <li>Your EVE Online password or account details. You log in on CCP's own site; the bot never sees them.</li>
  <li>EVE access or refresh tokens. The bot asks only for your character's public identity, uses the login
    once to prove you own the character, and then discards it.</li>
  <li>Your messages. The bot doesn't read message content.</li>
</ul>

<h2>Where the information comes from</h2>
<p>Your Discord id comes from Discord when you use a command. Character details come from your EVE login
and from EVE Online's public API (ESI), which the bot re-checks regularly so roles stay correct. Faction
warfare enlistment is read from public data too.</p>

<h2>Who can see it</h2>
<ul>
  <li><strong>You:</strong> <code>/characters</code> lists what's linked to you.</li>
  <li><strong>Server staff:</strong> on servers you share with the bot, staff can look up the characters
    linked to a member (<code>/whois</code>) or who owns a character (<code>/whochar</code>). They only see
    members of their own server.</li>
  <li><strong>Discord:</strong> your roles and nickname are visible to the server like any other roles.</li>
</ul>
<p>The information is kept on a server run by the bot's operators. It isn't sold, shared with anyone else or
used for advertising.</p>

<h2>Removing your information</h2>
<ul>
  <li>Use <code>/unlink</code> to remove a character. It's deleted straight away, and the roles it gave you
    are removed.</li>
  <li>To have everything about you deleted, email <a href="mailto:${contactEmail}">${contactEmail}</a> from
    a contact we can match to your Discord account, or ask a server admin to pass it on.</li>
</ul>

<h2>Changes and contact</h2>
<p>This policy may be updated; the date below shows the latest version. Questions:
<a href="mailto:${contactEmail}">${contactEmail}</a>.</p>
`);
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>firewatcher-bot ${title}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#e6e6e6;margin:0;padding:24px 16px;line-height:1.6}
  main{max-width:46rem;margin:0 auto}
  h1{font-size:1.7rem;margin:0 0 4px} h2{font-size:1.15rem;margin:28px 0 8px}
  .updated{color:#999;margin:0 0 20px} a{color:#7ab7ff} code{background:#222;padding:1px 5px;border-radius:3px}
  table{border-collapse:collapse;width:100%;font-size:.95rem} th,td{border:1px solid #333;padding:8px;text-align:left;vertical-align:top}
  th{background:#1c1c1c} @media (max-width:600px){table,tr,td,th{display:block} tr{margin-bottom:10px} th{display:none}}
  footer{margin-top:32px;color:#999;font-size:.9rem}
</style></head>
<body><main>
<h1>firewatcher-bot ${title}</h1>
<p class="updated">Last updated ${UPDATED}</p>
${body}
<footer><a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a></footer>
</main></body></html>`;
}
