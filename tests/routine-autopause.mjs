import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'http://localhost:5173';
Object.assign(process.env, {
  APP_URL: origin, DB_PATH: ':memory:', DEV_LOGIN: '1', ALLOWED_EMAILS: '',
  HQ_LOCAL_ENGINES: '0', SESSION_SECRET: 'routine-test-only',
});

const { db } = await import('../server/dist/db.js');
const { enqueue, isBotBusy } = await import('../server/dist/agent/loop.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRoutines, runRoutine, unscheduleRoutine } = await import('../server/dist/routines.js');
const { api } = await import('../server/dist/routes.js');
const { hub } = await import('../server/dist/lib/hub.js');
const { listRows } = await import('../server/dist/store.js');

initRooms();
initSubagents();
initRoutines(enqueue);
db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, 0)')
  .run('owner', 'owner@example.test', 'Owner');
const headers = { origin, 'content-type': 'application/json' };
const login = await api.request('/auth/dev', {
  method: 'POST', headers, body: JSON.stringify({ email: 'owner@example.test' }),
});
assert.equal(login.status, 200);
headers.cookie = login.headers.get('set-cookie').split(';')[0];

function fixture(t, id, outcomes) {
  const botId = `bot-${id}`;
  db.prepare(`INSERT INTO bots (id, user_id, name, hermes_url, hermes_key, created_at, updated_at)
    VALUES (?, 'owner', 'Test Bot', 'http://hermes.example.test', 'test-key', 0, 0)`).run(botId);
  db.prepare(`INSERT INTO routines (id, bot_id, name, prompt, schedule, created_at)
    VALUES (?, ?, 'Digest', 'Send a digest', '0 0 31 12 *', 0)`).run(id, botId);
  t.after(() => unscheduleRoutine(id));
  t.mock.method(console, 'error', () => {});
  const started = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const { pathname } = new URL(input);
    if (pathname === '/v1/runs' && options.method === 'POST') {
      started.push(outcomes[started.length]);
      return Response.json({ run_id: String(started.length) });
    }
    const match = /^\/v1\/runs\/(\d+)\/events$/.exec(pathname);
    assert(match, `unexpected request ${pathname}`);
    const [type, data] = await started[Number(match[1]) - 1];
    return new Response(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const state = () => db.prepare('SELECT enabled, consecutive_failures FROM routines WHERE id=?').get(id);
  const rows = () => listRows(botId).map(({ body }) => body);
  const drain = async () => {
    for (let tries = 0; isBotBusy(botId) && tries < 1000; tries++) await delay(1);
    assert.equal(isBotBusy(botId), false, 'routine queue did not drain');
  };
  const run = async () => { runRoutine(id); await drain(); };
  const setEnabled = async (enabled) => {
    const response = await api.request(`/routines/${id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ enabled }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).routine.enabled, enabled);
  };
  return { botId, state, rows, run, drain, setEnabled, started };
}

const failure = ['run.failed', { error: 'operation was aborted due to timeout' }];
const success = ['run.completed', {}];

test('three consecutive failures pause the routine once and invalidate queued runs', async (t) => {
  const id = 'auto-pause';
  const { botId, run, drain, state, rows, started } = fixture(t, id, [
    failure, failure, ['run.failed', { error: 'connection refused' }],
  ]);
  const events = [];
  t.after(hub.subscribe('owner', (event) => events.push(event)));

  await run();
  await run();
  assert.deepEqual(state(), { enabled: 1, consecutive_failures: 2 });
  runRoutine(id);
  runRoutine(id);
  await drain();
  assert.deepEqual(state(), { enabled: 0, consecutive_failures: 3 });
  assert.deepEqual(rows().filter(({ tone }) => tone === 'warn').map(({ text }) => text), [
    'Paused Digest after 3 failed runs: connection refused. Turn it back on in Manage.',
  ]);
  assert.deepEqual(events.filter(({ type }) => type === 'routines'), [{ type: 'routines', botId }]);
  await run();
  assert.equal(started.length, 3);
});

test('a successful run resets the streak', async (t) => {
  const { run, state } = fixture(t, 'success-reset', [failure, failure, success, failure]);
  await run();
  await run();
  assert.equal(state().consecutive_failures, 2);
  await run();
  assert.deepEqual(state(), { enabled: 1, consecutive_failures: 0 });
  await run();
  assert.deepEqual(state(), { enabled: 1, consecutive_failures: 1 });
});

test('re-enabling through Manage starts a fresh streak', async (t) => {
  const { run, state, setEnabled } = fixture(t, 'enable-reset', [failure, failure, failure, failure]);
  for (let i = 0; i < 3; i++) await run();
  assert.equal(state().enabled, 0);
  await setEnabled(true);
  assert.deepEqual(state(), { enabled: 1, consecutive_failures: 0 });
  await run();
  assert.deepEqual(state(), { enabled: 1, consecutive_failures: 1 });
});

test('a run admitted before a pause and re-enable cannot add to the fresh streak', { timeout: 5000 }, async (t) => {
  const pending = Promise.withResolvers();
  const id = 'stale-run';
  const { state, setEnabled, drain } = fixture(t, id, [pending.promise]);
  const entered = Promise.withResolvers();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    if (new URL(input).pathname === '/v1/runs/1/events') entered.resolve();
    return fetch(input, options);
  });
  try {
    runRoutine(id);
    await entered.promise;
    await setEnabled(false);
    await setEnabled(true);
  } finally {
    pending.resolve(failure);
    await drain();
  }
  assert.deepEqual(state(), { enabled: 1, consecutive_failures: 0 });
});
