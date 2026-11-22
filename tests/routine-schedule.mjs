import assert from 'node:assert/strict';
import { test } from 'node:test';

const origin = 'http://localhost:5173';
Object.assign(process.env, {
  APP_URL: origin, DB_PATH: ':memory:', DEV_LOGIN: '1', ALLOWED_EMAILS: '',
  HQ_LOCAL_ENGINES: '0', SESSION_SECRET: 'routine-schedule-test-only',
});

const { db } = await import('../server/dist/db.js');
const { api } = await import('../server/dist/routes.js');
const { unscheduleRoutine } = await import('../server/dist/routines.js');

for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, 0)').run(id, `${id}@example.test`, id);
}
const headers = { origin, 'content-type': 'application/json' };
const login = await api.request('/auth/dev', { method: 'POST', headers, body: JSON.stringify({ email: 'owner@example.test' }) });
assert.equal(login.status, 200);
headers.cookie = login.headers.get('set-cookie').split(';')[0];

db.prepare(`INSERT INTO bots (id, user_id, name, hermes_url, hermes_key, created_at, updated_at)
  VALUES ('bot', 'owner', 'Bot', 'http://hermes.example.test', 'k', 0, 0), ('foreign', 'other', 'Bot', 'http://hermes.example.test', 'k', 0, 0)`).run();
const add = (id, bot, name, schedule, enabled = 0) => db.prepare(
  `INSERT INTO routines (id, bot_id, name, prompt, schedule, timezone, enabled, created_at) VALUES (?, ?, ?, 'p', ?, 'America/Halifax', ?, 0)`)
  .run(id, bot, name, schedule, enabled);
add('r1', 'bot', 'Inbox', '*/5 * * * *');
add('r2', 'bot', 'Other', 'event:Taken');
add('r3', 'foreign', 'Theirs', '*/5 * * * *');
const patch = (id, body) => api.request(`/routines/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
const row = (id) => db.prepare('SELECT schedule, timezone, enabled, run_revision FROM routines WHERE id=?').get(id);

test('schedule switches to an event and enables in one request', async (t) => {
  t.after(() => unscheduleRoutine('r1'));
  const before = row('r1').run_revision;
  const res = await patch('r1', { schedule: 'event:Inbox', enabled: true });
  assert.equal(res.status, 200);
  const { routine } = await res.json();
  assert.equal(routine.schedule, 'event:Inbox');
  assert.equal(routine.enabled, true);
  assert.equal(routine.nextRunAt, null);
  assert.equal(row('r1').enabled, 1);
  assert.ok(row('r1').run_revision > before);
});

test('a cron schedule and timezone can be set', async (t) => {
  t.after(() => unscheduleRoutine('r1'));
  const res = await patch('r1', { schedule: '0 9 * * 1', timezone: 'UTC' });
  assert.equal(res.status, 200);
  assert.deepEqual([row('r1').schedule, row('r1').timezone], ['0 9 * * 1', 'UTC']);
});

test('invalid schedules, fields and duplicate events are rejected without changes', async () => {
  const keep = row('r1');
  for (const body of [{ schedule: 'not a cron' }, { schedule: 'event:  ' }, { timezone: 'Nowhere/Land' }, { schedule: 5 }, {}]) {
    assert.equal((await patch('r1', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await patch('r1', { schedule: 'event:Taken' })).status, 409);
  assert.deepEqual(row('r1'), keep);
});

test('enabled alone still toggles, and other owners are not found', async (t) => {
  t.after(() => unscheduleRoutine('r1'));
  assert.equal((await patch('r1', { enabled: false })).status, 200);
  assert.equal(row('r1').enabled, 0);
  assert.equal((await patch('r3', { schedule: 'event:X' })).status, 404);
  assert.equal(row('r3').schedule, '*/5 * * * *');
});
