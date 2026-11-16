#!/usr/bin/env bash
# Stage and activate an approved revision on the Bot HQ guest.
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s <full reviewed commit SHA>\n' "$0" >&2
  exit 2
fi
revision=$1
cd /var/lib/bot-hq
release="$PWD/releases/$revision"

sudo -H -u bot-hq /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin \
  HQ_RELEASES_DIR="$PWD/releases" /usr/local/sbin/stage-bot-hq-release "$revision"

# Verify the actual target as the service user before touching the current release.
if [[ -L "$release" ]] ||
   ! sudo -H -u bot-hq test -s "$release/server/dist/index.js" ||
   ! sudo -H -u bot-hq test -s "$release/web/dist/index.html" ||
   [[ $(sudo -H -u bot-hq git -C "$release" rev-parse HEAD) != "$revision" ]]; then
  printf 'No complete, readable release for %s\n' "$revision" >&2
  exit 1
fi

if [[ -L current ]]; then
  printf 'Previous release: %s\n' "$(readlink current)"
fi
ln -sfn "$release" current.next
mv -Tf current.next current
systemctl daemon-reload
systemctl enable bot-hq.service
systemctl restart bot-hq.service
curl -fsS --retry 5 --retry-connrefused --max-time 3 http://127.0.0.1:18787/api/health
printf '\n'
