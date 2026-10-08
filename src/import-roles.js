// One-time copy of the role manager server's corpRoles and allianceRoles from guilds.json into the
// role manager, so staff can see and edit them in the panel. guilds.json is not changed: after
// checking the panel, delete those rules from the file yourself. Until then both hand out the same
// roles, which is harmless.
//
//   npm run import-roles             show what would be imported
//   npm run import-roles -- --apply  import it
import { config } from './config.js';
import { Store } from './db.js';
import { EveClient } from './eve.js';

const apply = process.argv.includes('--apply');
if (!config.manager) throw new Error('Set MANAGER_GUILD_ID in .env first.');
const guildId = config.manager.guildId;
const store = new Store(config.dbPath);
const eve = new EveClient({ ...config.eve, contactEmail: config.contactEmail });
const actor = { id: '0', name: 'guilds.json import' };

let added = 0;
for (const rule of config.guilds.get(guildId).corpRoles) {
  const ids = [
    ...[...rule.alliances].map((id) => ['alliance', id]),
    ...[...rule.corporations].map((id) => ['corporation', id]),
  ];
  for (const [kind, eveId] of ids) {
    if (store.findRoleEntry(guildId, kind, eveId, rule.roleId)) {
      console.log(`  already there: ${kind} ${eveId} → role ${rule.roleId}`);
      continue;
    }
    const info = await eve.info(kind === 'alliance' ? 'alliances' : 'corporations', eveId);
    console.log(`${apply ? 'Importing' : 'Would import'}: ${kind} ${info.name} [${info.ticker}] → role ${rule.roleId} (${rule.name})`);
    if (!apply) continue;
    store.addRoleEntry(guildId, {
      kind,
      eveId,
      name: info.name,
      ticker: info.ticker,
      allianceId: kind === 'corporation' ? (info.alliance_id ?? null) : null,
      roleId: rule.roleId,
      notes: `Imported from guilds.json (${rule.name})`,
    }, actor);
    added++;
  }
}
if (apply) {
  if (added) store.logRoleAction(guildId, actor, 'add', `Imported ${added} entries from guilds.json`);
  console.log(`\nImported ${added}. Check the panel, then remove corpRoles/allianceRoles for this server from guilds.json.`);
} else {
  console.log('\nNothing changed. Run again with --apply to import.');
}
