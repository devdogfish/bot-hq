import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'loopback-test-only';
const { Hono } = await import('hono');
const { db } = await import('../server/dist/db.js');
const { requireUser } = await import('../server/dist/lib/auth.js');

const DAY = 24 * 3600 * 1000;
const TTL = 30 * DAY;
db.exec("INSERT INTO users (id, email, name, created_at) VALUES ('u', 'owner@example.test', 'Owner', 0)");
const addSession = (token, expiresAt) => db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, 'u', 0, expiresAt);
const expiry = (token) => db.prepare('SELECT expires_at FROM auth_sessions WHERE token=?').get(token).expires_at;

const app = new Hono().use('/*', requireUser).get('/x', (c) => c.text('ok'));
const visit = (cookie) => app.request('/x', { headers: { cookie } });

// A session 10 days from expiry is pushed back to 30 days and the cookie is re-sent.
addSession('old', Date.now() + 10 * DAY);
let res = await visit('bothq_session=old');
assert.equal(res.status, 200);
assert(expiry('old') > Date.now() + TTL - 60_000);
assert.match(res.headers.get('set-cookie') ?? '', /bothq_session=old;.*Max-Age=2592000/);

// Renewed under a day ago: no write, no cookie.
const before = expiry('old');
res = await visit('bothq_session=old');
assert.equal(expiry('old'), before);
assert.equal(res.headers.get('set-cookie'), null);

// The old cookie name still works and moves to the current name.
addSession('legacy', Date.now() + 5 * DAY);
res = await visit('grokbot_session=legacy');
assert.equal(res.status, 200);
assert.match(res.headers.get('set-cookie') ?? '', /bothq_session=legacy;/);

// An expired session is not revived.
addSession('dead', Date.now() - 1000);
res = await visit('bothq_session=dead');
assert.equal(res.status, 401);
assert(expiry('dead') < Date.now());

console.log('Visits slide a live session to 30 days at most once a day; expired sessions stay expired.');
