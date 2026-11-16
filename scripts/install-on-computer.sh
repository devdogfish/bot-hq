#!/usr/bin/env bash
# Unpack Bot HQ on the machine that will run the app. Requires Node.js and npm.
set -euo pipefail
tgz="${1:?usage: install-on-computer.sh <hq-app.tgz>}"
app="${HQ_INSTALL_DIR:-$HOME/.local/share/bot-hq}"
umask 077
mkdir -p "$app"
tar -xzf "$tgz" -C "$app"
(cd "$app" && npm ci --omit=dev)
if [ ! -f "$app/.env" ]; then
  sed "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/; s/^APP_URL=.*/APP_URL=http:\/\/localhost:8787/" "$app/.env.example" > "$app/.env"
fi
printf 'Bot HQ installed at %s\nSet the URLs and allowed emails in .env, then run npm start from that directory.\n' "$app"
