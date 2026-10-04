import http from 'node:http';
import { LinkError } from './verifier.js';

/** Hosts the EVE SSO callback that finishes a /verify. */
export function startWebServer({ store, eve, verifier, config }) {
  const callbackPath = new URL(config.eve.callbackUrl).pathname;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== callbackPath) return send(res, 404, 'Not found.');

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return send(res, 400, 'Missing login parameters.');

    const discordId = store.popPending(state);
    if (!discordId) {
      return send(res, 400, 'This login link has expired or was already used. Run /verify in Discord again.');
    }

    try {
      const login = await eve.verifyLogin(code);
      send(res, 200, await verifier.linkCharacter(discordId, login));
    } catch (err) {
      if (err instanceof LinkError) return send(res, 409, err.message);
      console.error('SSO callback failed:', err);
      send(res, 500, 'Something went wrong while verifying. Please try /verify again.');
    }
  });

  server.listen(config.webPort, () => console.log(`SSO callback listening on :${config.webPort}${callbackPath}`));
  return server;
}

function send(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>firewatcher-bot verification</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
p{max-width:32rem;font-size:1.1rem;line-height:1.5}</style></head>
<body><p>${escapeHtml(message)}</p></body></html>`);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
