import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'loopback-test-only';
process.env.HQ_HOST = '127.0.0.1';
process.env.HQ_TAILSCALE_OWNER_LOGIN = 'owner@github';
process.env.HQ_TAILSCALE_OWNER_EMAIL = 'Owner@Example.test';
const { Hono } = await import('hono');
const { db } = await import('../server/dist/db.js');
const { signInTailnetOwner, requireUser } = await import('../server/dist/lib/auth.js');

db.exec("INSERT INTO users (id, email, name, created_at) VALUES ('u', 'owner@example.test', 'Owner', 0)");
const app = new Hono()
  .get('/me', (c) => c.json({ user: signInTailnetOwner(c) }))
  .use('/x', requireUser).get('/x', (c) => c.text('ok'));
const me = (login) => app.request('/me', { headers: login ? { 'tailscale-user-login': login } : {} });

// The Owner's own device is signed in and gets a working session cookie.
let res = await me('owner@github');
assert.equal((await res.json()).user?.email, 'owner@example.test');
const cookie = (res.headers.get('set-cookie') ?? '').match(/bothq_session=[^;]+/)?.[0];
assert(cookie, 'session cookie set');
assert.equal((await app.request('/x', { headers: { cookie } })).status, 200);

// Another person's device, or a tagged device with no identity header, is not.
for (const login of ['someone@github', '']) {
  res = await me(login);
  assert.equal((await res.json()).user, null);
  assert.equal(res.headers.get('set-cookie'), null);
}
console.log('Only the configured Tailscale login signs in, and gets a normal session.');
