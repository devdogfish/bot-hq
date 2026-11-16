#!/usr/bin/env bash
# Print a one-time sign-in link from the Bot HQ machine.
set -euo pipefail
email="${1:?usage: sign-in-link.sh <email>}"
env_file="${ENV_FILE:-$(dirname "$0")/../.env}"

node --env-file="$env_file" --input-type=module - "$email" <<'JS'
import { createHmac } from 'node:crypto';
const { SESSION_SECRET, PORT = 8787, HQ_HOST = '127.0.0.1' } = process.env;
if (!SESSION_SECRET) throw new Error('Missing SESSION_SECRET');
const key = createHmac('sha256', SESSION_SECRET).update('owner-login').digest('hex');
const host = HQ_HOST === '0.0.0.0' ? '127.0.0.1' : HQ_HOST === '::' ? '[::1]' : HQ_HOST.includes(':') ? '[' + HQ_HOST + ']' : HQ_HOST;
const res = await fetch(`http://${host}:${PORT}/api/auth/owner`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.argv[2], link: true }),
});
const data = await res.json();
if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
console.log(data.url);
JS
