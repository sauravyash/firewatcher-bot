# Deploying firewatcher-bot on Google Cloud (free tier)

This runs the bot on Google Cloud's free **e2-micro** server, with a **Cloudflare Tunnel**
giving the EVE login callback a fixed HTTPS address. The tunnel means no firewall ports need
opening and no static IP is needed.

You need:
- A Google Cloud account with billing enabled (a card is required, but the e2-micro is free)
- A domain on Cloudflare (free plan is fine) for the callback URL, here `firewatcher-bot.yaa.sh`

## 1. Create the server

Google Cloud Console → **Compute Engine → VM instances → Create instance**:

| Setting | Value | Why |
|---|---|---|
| Region | `us-central1`, `us-west1`, or `us-east1` | Free tier only covers these |
| Machine type | **e2-micro** | The free one |
| Boot disk → OS | Debian 12 | |
| Boot disk → type | **Standard persistent disk**, 30 GB | The default "Balanced" disk is **not** free |
| Firewall | leave HTTP/HTTPS unchecked | The tunnel doesn't need them |

Or with `gcloud`:

```bash
gcloud compute instances create firewatcher-bot --zone=us-central1-a --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard
```

> **Set a budget alert** (Billing → Budgets & alerts, e.g. $1) so you hear about any surprise charge.
> Google has charged for external IPv4 addresses since 2024; check your first billing report to
> confirm what applies to your account.

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

In the Cloud Console, click **SSH** next to the VM. In that window, install git and clone the repo:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/sauravyash/firewatcher-bot.git
cd firewatcher-bot
sudo CLOUDFLARE_TUNNEL_TOKEN=paste-your-token-here bash deploy/setup.sh
```

The repo never contains your `.env`, so the first run creates a blank one from `.env.example`.

Fill in the config. Use `EVE_CALLBACK_URL=https://firewatcher-bot.yaa.sh/callback` and keep
`WEB_PORT=8080`:

```bash
sudo nano /opt/firewatcher-bot/.env
sudo systemctl restart firewatcher-bot
```

Check that it's running:

```bash
journalctl -u firewatcher-bot -f
```

You should see `Logged in as firewatcher-bot#…` and `SSO callback listening on :8080/callback`.

## Updating

Push your changes to GitHub, then on the VM:

```bash
cd ~/firewatcher-bot && git pull && sudo bash deploy/setup.sh
```

Your `.env` and the database (`/opt/firewatcher-bot/firewatcher-bot.db`) are kept.

## Useful commands

| | |
|---|---|
| Logs | `journalctl -u firewatcher-bot -f` |
| Restart | `sudo systemctl restart firewatcher-bot` |
| Status | `systemctl status firewatcher-bot cloudflared` |
| Back up the database | `sudo cp /opt/firewatcher-bot/firewatcher-bot.db ~/firewatcher-bot-backup.db` |
