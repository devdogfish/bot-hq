#!/usr/bin/env bash
# Build a pinned release as the Bot HQ service user. Activation is a separate runbook step.
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s <full commit SHA from devdogfish/bot-hq>\n' "$0" >&2
  exit 2
fi
if (( EUID == 0 )); then
  printf 'Build releases as the unprivileged Bot HQ user.\n' >&2
  exit 2
fi

revision=$1
release_dir=${HQ_RELEASES_DIR:-/var/lib/bot-hq/releases}
if [[ "$release_dir" != /* ]]; then
  printf 'HQ_RELEASES_DIR must be absolute.\n' >&2
  exit 2
fi
release="$release_dir/$revision"
if [[ -e "$release" || -L "$release" ]]; then
  printf 'Release already exists at %s\n' "$release"
  exit 0
fi

umask 027
mkdir -p "$release_dir"
build_dir=$(mktemp -d "$release_dir/.build-$revision.XXXXXXXX")
trap 'printf "Staging failed. Inspect %s\n" "$build_dir" >&2' ERR
chmod 750 "$build_dir"

git -C "$build_dir" init --quiet
git -C "$build_dir" fetch --quiet --no-tags --depth=1 https://github.com/devdogfish/bot-hq.git "$revision"
git -C "$build_dir" checkout --quiet --detach FETCH_HEAD
[[ $(git -C "$build_dir" rev-parse HEAD) == "$revision" ]]

(
  cd "$build_dir"
  npm ci --cache "$release_dir/.npm-cache" --no-audit --no-fund
  npm run typecheck
  npm run build
)

mv -T -- "$build_dir" "$release"
printf 'Staged %s\n' "$release"
