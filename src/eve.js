import { createRemoteJWKSet, jwtVerify } from 'jose';

const AUTHORIZE_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const JWKS = createRemoteJWKSet(new URL('https://login.eveonline.com/oauth/jwks'));
const ISSUERS = ['login.eveonline.com', 'https://login.eveonline.com'];
const ESI = 'https://esi.evetech.net/latest';

export class EveClient {
  constructor({ clientId, clientSecret, callbackUrl, contactEmail }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
    this.userAgent = `firewatcher-bot (${contactEmail})`;
    this.infoCache = new Map();
  }

  authorizeUrl(state) {
    const params = new URLSearchParams({
      response_type: 'code',
      redirect_uri: this.callbackUrl,
      client_id: this.clientId,
      scope: 'publicData',
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Exchanges an SSO code for a token and returns the verified character identity. */
  async verifyLogin(code) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code }),
    });
    if (!res.ok) throw new Error(`EVE token exchange failed: ${res.status} ${await res.text()}`);
    const { access_token: accessToken } = await res.json();

    const { payload } = await jwtVerify(accessToken, JWKS, { issuer: ISSUERS, audience: 'EVE Online' });
    if (![].concat(payload.aud).includes(this.clientId)) {
      throw new Error('EVE token was issued to a different application');
    }
    return {
      characterId: Number(payload.sub.split(':').pop()), // "CHARACTER:EVE:<id>"
      name: payload.name,
      // Changes when the character is transferred to another EVE account.
      ownerHash: payload.owner,
    };
  }

  async esi(path, init = {}) {
    const res = await fetch(`${ESI}${path}`, {
      ...init,
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(`ESI ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Bulk corp/alliance lookup with no auth needed. Returns Map<characterId, {corporationId, allianceId}>. */
  async affiliations(characterIds) {
    const result = new Map();
    for (let i = 0; i < characterIds.length; i += 1000) {
      const rows = await this.esi('/characters/affiliation/', {
        method: 'POST',
        body: JSON.stringify(characterIds.slice(i, i + 1000)),
      });
      for (const row of rows) {
        result.set(row.character_id, { corporationId: row.corporation_id, allianceId: row.alliance_id ?? null });
      }
    }
    return result;
  }

  /** Public corp/alliance info, cached until clearCache(). kind is "corporations" or "alliances". */
  async info(kind, id) {
    const key = `${kind}:${id}`;
    if (!this.infoCache.has(key)) this.infoCache.set(key, await this.esi(`/${kind}/${id}/`));
    return this.infoCache.get(key);
  }

  /** Corps can rename, change ticker, or enlist/leave militia, so the periodic sync refetches. */
  clearCache() {
    this.infoCache.clear();
  }

  async ticker(kind, id) {
    return id ? (await this.info(kind, id)).ticker : '';
  }

  /** The faction warfare faction a corp is enlisted with (including NPC militia corps), or null. */
  async militiaFaction(corporationId) {
    return corporationId ? ((await this.info('corporations', corporationId)).faction_id ?? null) : null;
  }
}
