import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const SESSION_SECONDS = 12 * 60 * 60;
const ACCESS_CACHE_MS = 60_000; // how long a member's admin/mod role is trusted before asking Discord again
const ESI_CACHE_MS = 10 * 60_000; // alliance member lists and corp info for the recommendations
const SYNC_DELAY_MS = 30_000; // changes are batched into one member sync
const COOKIE = 'role_manager';
const CSRF_HEADER = 'x-role-manager'; // a cross-site form can't set a custom header
const UNKNOWN_MEMBER = 10007;
const MAX_BODY = 16 * 1024;
const PAGE = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');

// Roles with any of these are staff roles, never membership tags.
const STAFF_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
];

export const manageRolesCommand = new SlashCommandBuilder()
  .setName('manage-roles')
  .setDescription('Open the alliance and corp role manager (admins and mods)')
  .setContexts(InteractionContextType.Guild)
  .toJSON();

/** A refusal or bad input the panel shows as-is. */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KINDS = { alliance: 'alliances', corporation: 'corporations' };

/**
 * The web panel where server admins and mods map alliances and corps to Discord roles, opened from
 * Discord with /manage-roles. Its entries become role rules alongside guilds.json (Verifier.managedRules).
 */
export class RoleManager {
  constructor({ client, store, eve, verifier, config }) {
    this.client = client;
    this.store = store;
    this.eve = eve;
    this.verifier = verifier;
    this.settings = config.manager;
    this.guildId = config.manager.guildId;
    this.secure = this.settings.publicUrl.startsWith('https:');
    this.sessionKey = createHmac('sha256', 'firewatcher-role-manager').update(config.discordToken).digest();
    this.access = new Map(); // discordId → { level, name, at }
    this.esiCache = new Map(); // key → { at, value }
    this.syncTimer = null;
  }

  guild() {
    return this.client.guilds.fetch(this.guildId);
  }

  // --- Who may use it ---

  /** 'admin', 'mod' or null, from the member's current roles. Cached for about a minute. */
  async accessFor(discordId, { fresh = false } = {}) {
    const cached = this.access.get(discordId);
    if (!fresh && cached && Date.now() - cached.at < ACCESS_CACHE_MS) return cached;
    const guild = await this.guild();
    let member = null;
    try {
      // force: the bot has no member events, so its cached copy of someone's roles can be stale.
      member = await guild.members.fetch({ user: discordId, force: true });
    } catch (err) {
      if (err.code !== UNKNOWN_MEMBER) throw err;
    }
    const has = (roleId) => Boolean(member?.roles.cache.has(roleId));
    const level = has(this.settings.adminRoleId) ? 'admin' : has(this.settings.modRoleId) ? 'mod' : null;
    const result = { level, name: member?.displayName ?? discordId, at: Date.now() };
    this.access.set(discordId, result);
    return result;
  }

  // --- /manage-roles ---

  async handleCommand(interaction) {
    const ephemeral = { flags: MessageFlags.Ephemeral };
    if (interaction.guildId !== this.guildId) {
      return interaction.reply({ ...ephemeral, content: "The role manager isn't set up for this server." });
    }
    await interaction.deferReply(ephemeral);
    const { level } = await this.accessFor(interaction.user.id, { fresh: true });
    if (!level) return interaction.editReply('Only server admins and mods can manage roles.');

    const token = randomBytes(24).toString('base64url');
    this.store.addPanelLink(token, this.guildId, interaction.user.id);
    const button = new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Open role manager')
      .setURL(`${this.settings.publicUrl}/roles/login?t=${token}`);
    return interaction.editReply({
      content: "Here's your link to the role manager. It works once and expires in 10 minutes. Don't share it.",
      components: [new ActionRowBuilder().addComponents(button)],
    });
  }

  // --- Sessions: a signed cookie, no server-side state ---

  sign(value) {
    return createHmac('sha256', this.sessionKey).update(value).digest('base64url');
  }

  sessionCookie(discordId) {
    const value = `${discordId}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
    const attrs = [`Max-Age=${SESSION_SECONDS}`, 'Path=/roles', 'HttpOnly', 'SameSite=Lax', this.secure && 'Secure'];
    return [`${COOKIE}=${value}.${this.sign(`${this.guildId}.${value}`)}`, ...attrs.filter(Boolean)].join('; ');
  }

  clearCookie() {
    return `${COOKIE}=; Max-Age=0; Path=/roles; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`;
  }

  /** The Discord id from a valid, unexpired session cookie, or null. */
  sessionUser(req) {
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`));
    const [discordId, expires, signature] = (cookie?.slice(COOKIE.length + 1) ?? '').split('.');
    if (!discordId || !expires || !signature) return null;
    const expected = Buffer.from(this.sign(`${this.guildId}.${discordId}.${expires}`));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (Number(expires) < Date.now() / 1000) return null;
    return discordId;
  }

  // --- HTTP ---

  /** Handles everything under /roles. */
  async handle(req, res, url) {
    try {
      if (url.pathname === '/roles/login' && req.method === 'GET') return await this.login(res, url);

      const discordId = this.sessionUser(req);
      const access = discordId ? await this.accessFor(discordId) : null;
      const isApi = url.pathname.startsWith('/roles/api/');

      if (!access?.level) {
        const message = discordId
          ? 'You no longer have the admin or mod role on the server.'
          : 'Run /manage-roles in Discord to open the role manager.';
        if (isApi) return json(res, 401, { error: message }, { 'Set-Cookie': this.clearCookie() });
        return page(res, 401, message, { 'Set-Cookie': this.clearCookie() });
      }

      if (!isApi) {
        if (req.method !== 'GET' || (url.pathname !== '/roles' && url.pathname !== '/roles/')) {
          return page(res, 404, 'Not found.');
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; img-src 'self' https://images.evetech.net; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(PAGE);
      }

      if (req.method !== 'GET' && req.headers[CSRF_HEADER] !== '1') {
        throw new ApiError(403, 'Missing request header. Reload the page.');
      }
      if (req.method === 'POST' && url.pathname === '/roles/api/logout') {
        return json(res, 200, { ok: true }, { 'Set-Cookie': this.clearCookie() });
      }
      const actor = { id: discordId, name: access.name, level: access.level };
      const body = req.method === 'GET' ? {} : await readJson(req);
      return json(res, 200, await this.api(req.method, url, body, actor));
    } catch (err) {
      if (err instanceof ApiError) return json(res, err.status, { error: err.message });
      if (err instanceof DiscordAPIError) {
        console.error('Role manager: Discord refused a request:', err.message);
        return json(res, 502, { error: `Discord refused: ${err.message}` });
      }
      console.error('Role manager request failed:', err);
      return json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  }

  async login(res, url) {
    const link = this.store.popPanelLink(url.searchParams.get('t') ?? '');
    if (!link || link.guildId !== this.guildId) {
      return page(res, 400, 'This link has expired or was already used. Run /manage-roles in Discord again.');
    }
    const { level } = await this.accessFor(link.discordId, { fresh: true });
    if (!level) return page(res, 403, 'Only server admins and mods can manage roles.');
    res.writeHead(303, { Location: '/roles/', 'Set-Cookie': this.sessionCookie(link.discordId), 'Cache-Control': 'no-store' });
    res.end();
  }

  async api(method, url, body, actor) {
    const path = url.pathname.slice('/roles/api'.length);
    const entryMatch = path.match(/^\/entries\/(\d+)$/);
    const roleMatch = path.match(/^\/roles\/(\d{17,20})$/);

    if (method === 'GET' && path === '/state') return this.state(actor);
    if (method === 'GET' && path === '/suggestions') return this.suggestions(url.searchParams.get('refresh') === '1');
    if (method === 'POST' && path === '/lookup') return this.lookup(body.kind, body.query);
    if (method === 'POST' && path === '/entries') return this.addEntry(body, actor);
    if (method === 'PATCH' && entryMatch) return this.editEntry(Number(entryMatch[1]), body, actor);
    if (method === 'DELETE' && entryMatch) return this.removeEntry(Number(entryMatch[1]), body, actor);
    if (method === 'PATCH' && roleMatch) return this.editRole(roleMatch[1], body, actor);
    throw new ApiError(404, 'Not found.');
  }

  // --- Safety ---

  /** Why the panel may not touch a role, or null if it's a plain membership-tag role. */
  protectedReason(guild, role) {
    if (role.id === guild.id) return '@everyone';
    if (role.id === this.settings.adminRoleId || role.id === this.settings.modRoleId) return 'staff role';
    if (role.managed) return 'managed by a bot or integration';
    if (STAFF_PERMISSIONS.some((p) => role.permissions.has(p, false))) return 'has admin or manage permissions';
    if (guild.members.me.roles.highest.comparePositionTo(role) <= 0) return "at or above the bot's highest role";
    return null;
  }

  /** A role the panel may link or change; throws a readable refusal otherwise. */
  usableRole(guild, roleId) {
    const role = guild.roles.cache.get(String(roleId));
    if (!role) throw new ApiError(404, 'That role no longer exists in Discord.');
    const reason = this.protectedReason(guild, role);
    if (reason) throw new ApiError(403, `The panel can't use ${role.name}: ${reason}.`);
    return role;
  }

  reason(actor, what) {
    return `Role manager: ${what} by ${actor.name} (${actor.id})`.slice(0, 512);
  }

  // --- Reads ---

  roleInfo(guild, role) {
    return {
      id: role.id,
      name: role.name,
      color: hex(role.colors?.primaryColor ?? role.color),
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      locked: this.protectedReason(guild, role),
    };
  }

  async state(actor) {
    const guild = await this.guild();
    const entries = this.store.roleEntries(this.guildId).map((e) => {
      const role = e.role_id ? guild.roles.cache.get(e.role_id) : null;
      return {
        id: e.id,
        kind: e.kind,
        eveId: e.eve_id,
        name: e.name,
        ticker: e.ticker,
        allianceId: e.alliance_id,
        notes: e.notes,
        suggestCorps: Boolean(e.suggest_corps),
        updatedAt: e.updated_at,
        updatedBy: e.updated_by_name,
        role: e.role_id ? (role ? this.roleInfo(guild, role) : { id: e.role_id, missing: true }) : null,
      };
    });
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => this.roleInfo(guild, r));
    const roleName = (id) => guild.roles.cache.get(id)?.name ?? 'role missing';
    // Rules still in guilds.json: shown read-only so staff see everything that hands out roles.
    const fileRules = (this.verifier.guilds.get(this.guildId)?.corpRoles ?? []).map((r) => ({
      name: r.name,
      roleId: r.roleId,
      roleName: roleName(r.roleId),
      corporations: [...r.corporations],
      alliances: [...r.alliances],
    }));
    return {
      me: { name: actor.name, level: actor.level },
      server: guild.name,
      roleNameFormat: this.settings.roleNameFormat,
      entries,
      roles,
      fileRules,
      log: this.store.roleLog(this.guildId).map((l) => ({
        at: l.at, actor: l.actor_name, action: l.action, summary: l.summary,
      })),
    };
  }

  /** ESI calls cached for ~10 minutes, shared by the recommendations. */
  async cached(key, load, refresh = false) {
    const hit = this.esiCache.get(key);
    if (!refresh && hit && Date.now() - hit.at < ESI_CACHE_MS) return hit.value;
    const value = await load();
    this.esiCache.set(key, { at: Date.now(), value });
    return value;
  }

  async corpInfo(corpId, refresh = false) {
    return this.cached(`corp:${corpId}`, () => this.eve.esi(`/corporations/${corpId}/`), refresh);
  }

  async allianceInfo(allianceId) {
    return this.cached(`alliance:${allianceId}`, () => this.eve.esi(`/alliances/${allianceId}/`));
  }

  /** Name or id → { kind, eveId, name, ticker, allianceId, allianceName } from ESI. */
  async lookup(kind, query) {
    if (!KINDS[kind]) throw new ApiError(400, 'Choose alliance or corporation.');
    const text = String(query ?? '').trim();
    if (!text) throw new ApiError(400, 'Enter a name or EVE id.');
    let eveId = /^\d+$/.test(text) ? Number(text) : await this.eve.idForName(KINDS[kind], text);
    if (!eveId) throw new ApiError(404, `No ${kind} is named exactly "${text}".`);
    let info;
    try {
      info = await this.eve.esi(`/${KINDS[kind]}/${eveId}/`);
    } catch (err) {
      if (err.status === 404 || err.status === 400) throw new ApiError(404, `No ${kind} has id ${eveId}.`);
      throw err;
    }
    const allianceId = kind === 'corporation' ? (info.alliance_id ?? null) : null;
    const allianceName = allianceId ? (await this.allianceInfo(allianceId)).name : null;
    return { kind, eveId, name: info.name, ticker: info.ticker, allianceId, allianceName };
  }

  /**
   * Member corps of the listed alliances that aren't on the list yet, and listed corps that have left
   * the alliance they were recorded in. Alliances with suggestCorps off are skipped for new corps.
   */
  async suggestions(refresh = false) {
    const entries = this.store.roleEntries(this.guildId);
    const fileRules = this.verifier.guilds.get(this.guildId)?.corpRoles ?? [];
    const listedCorps = new Set([
      ...entries.filter((e) => e.kind === 'corporation').map((e) => e.eve_id),
      ...fileRules.flatMap((r) => [...r.corporations]),
    ]);
    const alliances = new Map();
    for (const e of entries.filter((x) => x.kind === 'alliance')) {
      const a = alliances.get(e.eve_id) ?? { eveId: e.eve_id, name: e.name, ticker: e.ticker, suggest: false, roleId: null };
      a.suggest ||= Boolean(e.suggest_corps);
      a.roleId ??= e.role_id;
      alliances.set(e.eve_id, a);
    }

    const guild = await this.guild();
    const members = new Map();
    const failed = [];
    for (const a of alliances.values()) {
      try {
        members.set(a.eveId, new Set(await this.cached(`members:${a.eveId}`, () => this.eve.allianceCorporations(a.eveId), refresh)));
      } catch (err) {
        console.error(`Role manager: could not load corps of alliance ${a.eveId}:`, err.message);
        failed.push(a.name);
      }
    }

    const newCorps = [];
    for (const a of alliances.values()) {
      if (!a.suggest || !members.has(a.eveId)) continue;
      const role = a.roleId ? guild.roles.cache.get(a.roleId) : null;
      const unlisted = [...members.get(a.eveId)].filter((id) => !listedCorps.has(id));
      const infos = await mapLimit(unlisted, 8, (id) => this.corpInfo(id).catch(() => null));
      unlisted.forEach((corpId, i) => {
        newCorps.push({
          corpId,
          name: infos[i]?.name ?? `Corporation ${corpId}`,
          ticker: infos[i]?.ticker ?? '',
          allianceId: a.eveId,
          allianceName: a.name,
          color: role ? hex(role.colors?.primaryColor ?? role.color) : null,
        });
      });
    }

    const leftCorps = [];
    for (const e of entries) {
      if (e.kind !== 'corporation' || !e.alliance_id || !members.has(e.alliance_id)) continue;
      if (members.get(e.alliance_id).has(e.eve_id)) continue;
      const now = await this.corpInfo(e.eve_id, refresh).catch(() => null);
      const nowAllianceId = now?.alliance_id ?? null;
      leftCorps.push({
        entryId: e.id,
        corpId: e.eve_id,
        name: e.name,
        ticker: e.ticker,
        allianceName: alliances.get(e.alliance_id).name,
        nowAllianceId,
        nowAllianceName: nowAllianceId ? (await this.allianceInfo(nowAllianceId).catch(() => null))?.name ?? null : null,
      });
    }

    const checkedAt = Math.min(...[...alliances.keys()].map((id) => this.esiCache.get(`members:${id}`)?.at ?? Date.now()));
    return { checkedAt: alliances.size ? checkedAt : Date.now(), newCorps, leftCorps, failed };
  }

  // --- Writes ---

  requireAdmin(actor, what) {
    if (actor.level !== 'admin') throw new ApiError(403, `Only admins can ${what}.`);
  }

  /** Creates a membership-tag role: no permissions, below the bot. */
  async createRole(guild, { name, color }, actor) {
    const roleName = String(name ?? '').trim();
    if (!roleName || roleName.length > 100) throw new ApiError(400, 'Role names must be 1 to 100 characters.');
    const role = await guild.roles.create({
      name: roleName,
      colors: { primaryColor: parseColor(color) },
      permissions: [],
      hoist: false,
      mentionable: false,
      reason: this.reason(actor, `create role for ${roleName}`),
    });
    this.store.logRoleAction(this.guildId, actor, 'create role', `Created role ${role.name}`);
    return role;
  }

  /** Turns a { mode, roleId, name, color } choice into a role id (or null), creating the role if asked. */
  async resolveRoleChoice(guild, choice, info, actor) {
    switch (choice?.mode) {
      case 'none':
        return null;
      case 'existing':
        return this.usableRole(guild, choice.roleId).id;
      case 'new': {
        const name = choice.name || this.defaultRoleName(info);
        return (await this.createRole(guild, { name, color: choice.color }, actor)).id;
      }
      default:
        throw new ApiError(400, 'Choose a new role, an existing role or no role.');
    }
  }

  defaultRoleName({ name, ticker }) {
    return this.settings.roleNameFormat.replaceAll('{ticker}', ticker).replaceAll('{name}', name).trim().slice(0, 100);
  }

  async addEntry(body, actor) {
    const guild = await this.guild();
    const info = await this.lookup(body.kind, body.eveId);
    if (body.role?.mode === 'existing') this.usableRole(guild, body.role.roleId);
    const plannedRoleId = body.role?.mode === 'existing' ? String(body.role.roleId) : null;
    if (body.role?.mode !== 'new' && this.store.findRoleEntry(this.guildId, info.kind, info.eveId, plannedRoleId)) {
      throw new ApiError(409, `${info.name} is already on the list with that role.`);
    }
    const roleId = await this.resolveRoleChoice(guild, body.role, info, actor);
    const entry = this.store.addRoleEntry(this.guildId, {
      kind: info.kind,
      eveId: info.eveId,
      name: info.name,
      ticker: info.ticker,
      allianceId: info.allianceId,
      roleId,
      notes: cleanNotes(body.notes),
      suggestCorps: body.suggestCorps !== false,
    }, actor);
    const roleText = roleId ? ` with role ${guild.roles.cache.get(roleId)?.name}` : ', no role';
    this.store.logRoleAction(this.guildId, actor, 'add', `Added ${info.kind} ${label(info)}${roleText}`);
    this.scheduleSync();
    return { id: entry.id };
  }

  async editEntry(id, body, actor) {
    const guild = await this.guild();
    const entry = this.store.roleEntry(this.guildId, id);
    if (!entry) throw new ApiError(404, 'That entry was removed. Reload the page.');
    const changes = {};
    const said = [];
    if (body.notes !== undefined && cleanNotes(body.notes) !== entry.notes) {
      changes.notes = cleanNotes(body.notes);
      said.push('notes');
    }
    if (body.suggestCorps !== undefined && Boolean(body.suggestCorps) !== Boolean(entry.suggest_corps)) {
      changes.suggestCorps = Boolean(body.suggestCorps);
      said.push(changes.suggestCorps ? 'suggest new corps on' : 'suggest new corps off');
    }
    if (body.role) {
      const sameRole = body.role.mode === 'existing' && String(body.role.roleId) === entry.role_id;
      if (!sameRole) {
        if (body.role.mode === 'existing') this.usableRole(guild, body.role.roleId);
        const plannedRoleId = body.role.mode === 'existing' ? String(body.role.roleId) : null;
        if (body.role.mode !== 'new' && this.store.findRoleEntry(this.guildId, entry.kind, entry.eve_id, plannedRoleId)) {
          throw new ApiError(409, `${entry.name} is already on the list with that role.`);
        }
        changes.roleId = await this.resolveRoleChoice(guild, body.role, entry, actor);
        said.push(changes.roleId ? `role → ${guild.roles.cache.get(changes.roleId)?.name}` : 'role unlinked');
      }
    }
    if (!said.length) return { id };
    this.store.updateRoleEntry(this.guildId, id, changes, actor);
    this.store.logRoleAction(this.guildId, actor, 'edit', `Edited ${label(entry)}: ${said.join(', ')}`);
    if ('roleId' in changes) this.scheduleSync();
    return { id };
  }

  async removeEntry(id, body, actor) {
    this.requireAdmin(actor, 'remove entries');
    const guild = await this.guild();
    const entry = this.store.roleEntry(this.guildId, id);
    if (!entry) throw new ApiError(404, 'That entry was already removed. Reload the page.');

    let deletedRole = null;
    if (body.deleteRole && entry.role_id) {
      const role = guild.roles.cache.get(entry.role_id);
      if (role) {
        const others = this.store.entriesUsingRole(this.guildId, role.id, id);
        if (others.length) {
          throw new ApiError(409, `${role.name} is also used by ${others.map((e) => e.name).join(', ')}. Remove the entry without deleting the role.`);
        }
        const inFile = (this.verifier.guilds.get(this.guildId)?.corpRoles ?? []).some((r) => r.roleId === role.id);
        if (inFile) throw new ApiError(409, `${role.name} is also used in guilds.json. Remove the entry without deleting the role.`);
        this.usableRole(guild, role.id);
        await role.delete(this.reason(actor, `remove ${entry.name}`));
        deletedRole = role.name;
        this.store.logRoleAction(this.guildId, actor, 'delete role', `Deleted role ${role.name}`);
      }
    }
    this.store.removeRoleEntry(this.guildId, id);
    this.store.logRoleAction(this.guildId, actor, 'remove', `Removed ${entry.kind} ${label(entry)}${deletedRole ? ` and its role ${deletedRole}` : ''}`);
    this.scheduleSync();
    return { ok: true };
  }

  /** Only name, colour, hoist and mentionable, and only on roles an entry links to. */
  async editRole(roleId, body, actor) {
    const guild = await this.guild();
    if (!this.store.entriesUsingRole(this.guildId, roleId).length) {
      throw new ApiError(403, 'Only roles linked to an entry can be edited here.');
    }
    const role = this.usableRole(guild, roleId);
    const edit = {};
    const said = [];
    if (body.name !== undefined && String(body.name).trim() !== role.name) {
      const name = String(body.name).trim();
      if (!name || name.length > 100) throw new ApiError(400, 'Role names must be 1 to 100 characters.');
      edit.name = name;
      said.push(`renamed to ${name}`);
    }
    const currentColor = hex(role.colors?.primaryColor ?? role.color);
    if (body.color !== undefined && body.color.toLowerCase() !== currentColor) {
      edit.colors = { primaryColor: parseColor(body.color) };
      said.push(`colour ${body.color.toLowerCase()}`);
    }
    for (const key of ['hoist', 'mentionable']) {
      if (body[key] !== undefined && Boolean(body[key]) !== role[key]) {
        edit[key] = Boolean(body[key]);
        said.push(`${key} ${edit[key] ? 'on' : 'off'}`);
      }
    }
    if (!said.length) return { ok: true };
    await role.edit({ ...edit, reason: this.reason(actor, `edit role ${role.name}`) });
    this.store.logRoleAction(this.guildId, actor, 'edit role', `Role ${role.name}: ${said.join(', ')}`);
    return { ok: true };
  }

  /** Batches panel changes into one member sync shortly after the last change. */
  scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.verifier.syncAll().catch((err) => console.error('Sync after role manager change failed:', err));
    }, SYNC_DELAY_MS);
  }
}

// --- Helpers ---

function hex(color) {
  return `#${(color ?? 0).toString(16).padStart(6, '0')}`;
}

function parseColor(value) {
  if (value == null || value === '') return 0;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new ApiError(400, 'Colours must look like #ff8800.');
  return parseInt(value.slice(1), 16);
}

function cleanNotes(notes) {
  return String(notes ?? '').trim().slice(0, 500);
}

function label({ name, ticker }) {
  return ticker ? `${name} [${ticker}]` : name;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new ApiError(415, 'Expected JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ApiError(400, 'Invalid JSON.');
  }
}

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function page(res, status, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Role manager</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
p{max-width:32rem;font-size:1.1rem;line-height:1.5}</style></head>
<body><p>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p></body></html>`);
}
