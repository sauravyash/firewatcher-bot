# Deploying firewatcher-bot in an LXC container

This runs the bot as a systemd service in a Debian/Ubuntu LXC container (e.g. on Proxmox), with a
**Cloudflare Tunnel** giving the EVE login callback a public HTTPS address at
`https://firewatcher-bot.yaa.sh/callback`. The tunnel connects outward from the container, so you
don't need to open ports on your router or have a static IP.

The same steps work on any Debian/Ubuntu machine or VM with systemd.

## 1. Create the container

A small container is plenty: **1 CPU, 512 MB RAM, 4 GB disk**, from a **Debian 12** (or Ubuntu 24.04)
template. Give it normal outbound internet access; it needs no inbound ports.

> **Proxmox:** leave the container *unprivileged* and make sure **Options → Features → nesting** is
> on (the default for new containers). The service uses systemd sandboxing, which needs nesting.

## 2. Create the Cloudflare Tunnel

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared*:

1. Name it `firewatcher-bot`. On the install screen, copy the **token** (the long string after
   `cloudflared service install`). You don't need to run their install command; the setup
   script does it.
2. Add a **public hostname**: `firewatcher-bot.yaa.sh` → service `HTTP` → `localhost:8080`.

   > Use a **one-level** subdomain like `firewatcher-bot.yaa.sh`. Cloudflare's free certificate only
   > covers `yaa.sh` and `*.yaa.sh`, so a deeper name like `firewatcher-bot.eve.yaa.sh`
   > gets HTTPS errors unless you pay for Advanced Certificate Manager.

Then, in the [EVE developer portal](https://developers.eveonline.com/applications), set your app's
callback URL to `https://firewatcher-bot.yaa.sh/callback`.

## 3. Clone and install

Open a shell in the container as root (Proxmox: select the container → **Console**, or
`pct enter <id>` on the host) and run:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/sauravyash/firewatcher-bot.git
cd firewatcher-bot
CLOUDFLARE_TUNNEL_TOKEN=paste-your-token-here bash deploy/setup.sh
```

The repo never contains your `.env`, so the first run creates a blank one from `.env.example`.
Fill it in. Use `EVE_CALLBACK_URL=https://firewatcher-bot.yaa.sh/callback` and keep
`WEB_PORT=8080`:

```bash
nano /opt/firewatcher-bot/.env
cp ~/firewatcher-bot/guilds.example.json /opt/firewatcher-bot/guilds.json
nano /opt/firewatcher-bot/guilds.json
systemctl restart firewatcher-bot
```

Check that it's running:

```bash
journalctl -u firewatcher-bot -f
```

You should see `Logged in as …` and `SSO callback listening on :8080/callback`. Opening
`https://firewatcher-bot.yaa.sh/callback` in a browser should show "Missing login parameters.",
which means the tunnel reaches the bot.

## Updating

Push your changes to GitHub, then in the container:

```bash
cd ~/firewatcher-bot && git pull && bash deploy/setup.sh
```

Your `.env`, `guilds.json` and the database (`/opt/firewatcher-bot/firewatcher-bot.db`) are kept.

## Troubleshooting

| Problem | Fix |
|---|---|
| Service fails with `status=226/NAMESPACE` | The container can't do systemd sandboxing. Turn on **nesting** for the container (Proxmox: Options → Features), or delete the `ProtectSystem`, `ProtectHome` and `PrivateTmp` lines from `/etc/systemd/system/firewatcher-bot.service` and run `systemctl daemon-reload && systemctl restart firewatcher-bot`. |
| Callback URL shows a Cloudflare error page | Check `systemctl status cloudflared` and that the tunnel's public hostname points to `HTTP` → `localhost:8080`. |
| `Missing required environment variable` in the logs | Fill in that value in `/opt/firewatcher-bot/.env`, then restart. |
| `guilds.json has problems` in the logs | Fix each listed line in `/opt/firewatcher-bot/guilds.json`. At startup, restart after fixing. Later, run `/resync`. |

## Useful commands

| | |
|---|---|
| Logs | `journalctl -u firewatcher-bot -f` |
| Restart | `systemctl restart firewatcher-bot` |
| Edit roles, corps, alliances | `nano /opt/firewatcher-bot/guilds.json`, check it with `cd /opt/firewatcher-bot && sudo -u firewatcher-bot npm run check-config`, then `/resync` in Discord |
| Status | `systemctl status firewatcher-bot cloudflared` |
| Back up the database | `cp /opt/firewatcher-bot/firewatcher-bot.db ~/firewatcher-bot-backup.db` |
