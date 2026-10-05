#!/usr/bin/env bash
# Installs (or updates) firewatcher-bot on a Debian/Ubuntu machine, VM, or LXC container.
# Run as root from the cloned repo folder:  bash deploy/setup.sh
# Optional Cloudflare Tunnel:               CLOUDFLARE_TUNNEL_TOKEN=... bash deploy/setup.sh
# (Not root? Prefix either command with sudo.)
# Safe to re-run: keeps the existing .env, settings.json and database, replaces the code, restarts the bot.
set -euo pipefail

APP_DIR=/opt/firewatcher-bot
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "Run as root (or with sudo)." >&2; exit 1; }

# Minimal container images often lack these.
if ! command -v curl >/dev/null; then
  apt-get update
  apt-get install -y curl ca-certificates
fi

# Node 22.13+ is needed for the built-in node:sqlite module.
if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') -lt 22 ]]; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing app to $APP_DIR"
id firewatcher-bot &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin firewatcher-bot
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/src"
cp -r "$SRC_DIR/src" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"

if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -f "$SRC_DIR/.env" ]]; then
    cp "$SRC_DIR/.env" "$APP_DIR/.env"
  else
    cp "$SRC_DIR/.env.example" "$APP_DIR/.env"
    NEEDS_CONFIG=1
  fi
fi

if [[ ! -f "$APP_DIR/settings.json" ]]; then
  if [[ -f "$SRC_DIR/settings.json" ]]; then
    cp "$SRC_DIR/settings.json" "$APP_DIR/settings.json"
  else
    cp "$SRC_DIR/settings.example.json" "$APP_DIR/settings.json"
    NEEDS_CONFIG=1
  fi
fi

(cd "$APP_DIR" && npm ci --omit=dev --no-fund --no-audit)
chown -R firewatcher-bot:firewatcher-bot "$APP_DIR"
chmod 600 "$APP_DIR/.env"

install -m 644 "$SRC_DIR/deploy/firewatcher-bot.service" /etc/systemd/system/firewatcher-bot.service
systemctl daemon-reload
systemctl enable firewatcher-bot

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]] && ! systemctl is-enabled cloudflared &>/dev/null; then
  echo "==> Installing Cloudflare Tunnel"
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
  cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"
fi

if [[ -n "${NEEDS_CONFIG:-}" ]]; then
  echo
  echo "!! Fill in $APP_DIR/.env and $APP_DIR/settings.json, then run:"
  echo "   systemctl restart firewatcher-bot"
  exit 0
fi

systemctl restart firewatcher-bot
echo
echo "==> firewatcher-bot is running. Follow the logs with:  journalctl -u firewatcher-bot -f"
