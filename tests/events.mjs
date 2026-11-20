import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

const secret = 'test-only-hook-secret';
const gateway = 'http://127.0.0.1:29654';
Object.assign(process.env, {
  DB_PATH: ':memory:',
  SESSION_SECRET: secret,
  HQ_LOCAL_ENGINES: '0',
});
const { db } = await import('../server/dist/db.js');
const { enqueueEvent } = await import('../server/dist/events.js');
const { hooksApi } = await import('../server/dist/routes-hooks.js');
const { mcpToken } = await import('../server/dist/engine.js');
const { isBotBusy, setBotPaused } = await import('../server/dist/agent/loop.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
const { listRows } = await import('../server/dist/store.js');
initSubagents();
initRooms();

db.exec(`
  INSERT INTO users (id, email, name, created_at) VALUES ('team', 'event@example.test', 'Test', 0);
  INSERT INTO bots (id, user_id, name, hermes_url, hermes_key, created_at, updated_at)
    VALUES ('bot', 'team', 'Bot', '${gateway}', 'test-gateway-key', 0, 0),
           ('other', 'team', 'Other', '${gateway}', 'test-gateway-key', 0, 0);
  INSERT INTO routines (id, bot_id, name, prompt, schedule, enabled, created_at)
    VALUES ('rt', 'bot', 'Inbox monitor', 'Process inbox changes.', 'event:inbox', 1, 0),
           ('off', 'bot', 'Paused', 'Do nothing.', 'event:disabled', 0, 0),
           ('cron', 'bot', 'Daily', 'Check daily.', '0 8 * * *', 1, 0),
           ('rt2', 'bot', 'Other inbox', 'Process it.', 'event:other', 1, 0),
           ('rt3', 'other', 'Inbox monitor', 'Process it.', 'event:inbox', 1, 0);
`);

const app = new Hono().route('/hooks', hooksApi);
const token = (botId) => createHmac('sha256', secret).update(`hook:${botId}`).digest('hex');
const event = (id) => ({ event_id: `mail:${id}`, summary: `New inbox activity ${id}`, refs: [`history:${id}`] });
function post(payload, { routine = 'inbox', botId = 'bot', bearer = token(botId) } = {}) {
  const streaming = payload instanceof ReadableStream;
  return app.request(`/hooks/${botId}/${encodeURIComponent(routine)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: streaming ? payload : JSON.stringify(payload),
    ...(streaming ? { duplex: 'half' } : {}),
  });
}

async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  assert.fail('Timed out waiting for event turn');
}

test('hook authenticates the Bot and matches only enabled event schedules', async () => {
  assert.equal((await post(event(0), { bearer: '0'.repeat(64) })).status, 401);
  assert.equal((await post(event(0), { botId: 'other', bearer: token('bot') })).status, 401);
  assert.equal((await post(event(0), { bearer: mcpToken('bot') })).status, 401);
  for (const routine of ['unknown', 'disabled', 'Daily']) {
    assert.equal((await post(event(0), { routine })).status, 404);
  }
  assert.equal((await post(event(0), { botId: 'missing' })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_events').get().n, 0);
});

test('hook rejects invalid fields and oversized streaming bodies', async () => {
  assert.equal((await post({ ...event(0), refs: 'history:0' })).status, 400);
  const oversized = JSON.stringify({ ...event(0), summary: 'é'.repeat(8192) });
  const bytes = new TextEncoder().encode(oversized);
  const response = await post(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 8192));
      controller.enqueue(bytes.subarray(8192));
      controller.close();
    },
  }));
  assert.equal(response.status, 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_events').get().n, 0);
});

test('five quick events start one turn and a duplicate never joins the batch', async (t) => {
  const runs = [];
  const streams = new Map();
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, gateway);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture' }] });
    if (url.pathname === '/v1/runs' && options.method === 'POST') {
      runs.push(JSON.parse(options.body).input);
      return Response.json({ run_id: String(runs.length) });
    }
    const streamId = /^\/v1\/runs\/(\d+)\/events$/.exec(url.pathname)?.[1];
    assert.ok(streamId, 'unexpected gateway API path: ' + url.pathname);
    return new Response(new ReadableStream({
      start(controller) { streams.set(streamId, controller); },
    }));
  });
  async function finish(id) {
    const stream = await until(() => streams.get(id));
    stream.enqueue(encoder.encode('event: run.completed\ndata: {}\n\n'));
    stream.close();
  }

  const events = [1, 2, 3, 4, 5].map(event);
  const startedAt = performance.now();
  const responses = await Promise.all(events.map((payload) => post(payload)));
  assert.deepEqual(responses.map(({ status }) => status), [202, 202, 202, 202, 202]);
  const duplicate = await post({ ...event(1), summary: 'Duplicate payload' });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { status: 'duplicate' });

  await until(() => streams.has('1'));
  const firstRunMs = Math.round(performance.now() - startedAt);
  assert.equal(runs.length, 1);
  const [instructions, ...json] = runs[0].split('\n[');
  assert.match(instructions, /Routine "Inbox monitor"[\s\S]*Process inbox changes\./);
  assert.deepEqual(JSON.parse('[' + json.join('\n[')), events);
  assert.deepEqual(listRows('bot').map(({ body }) => body.event), ['routine-run']);
  assert.ok(db.prepare('SELECT last_run_at FROM routines WHERE id=?').get('rt').last_run_at > 0);

  assert.equal(enqueueEvent('bot', 'other', event(1)), 'duplicate', 'IDs are scoped to the Bot');
  assert.equal(enqueueEvent('bot', 'inbox', event(6)), 'accepted');
  assert.equal(enqueueEvent('bot', 'inbox', event(7)), 'accepted');
  assert.equal(runs.length, 1, 'an active turn holds the next batch in the queue');
  await finish('1');
  await finish('2');
  await until(() => !isBotBusy('bot'));
  assert.equal(runs.length, 2);
  assert.doesNotMatch(runs[0], /history:6/);
  assert.match(runs[1], /history:6[\s\S]*history:7/);
  assert.equal((await post(event(1))).status, 200, 'ID remains seen after the turn ends');
  assert.equal(isBotBusy('bot'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_events WHERE bot_id=?').get('bot').n, 7);
  t.diagnostic(`Five hook deliveries produced 1 gateway turn in ${firstRunMs} ms with a mocked gateway.`);
});

test('paused Bots can retry and different Bots can accept the same ID', async () => {
  setBotPaused('other', true);
  assert.equal((await post(event(1), { botId: 'other' })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_events WHERE bot_id=?').get('other').n, 0);
  setBotPaused('other', false);

  assert.equal((await post(event(1), { botId: 'other' })).status, 202);
  db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run('rt3');
  await until(() => !isBotBusy('other'));
  assert.deepEqual(listRows('other'), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_events WHERE bot_id=?').get('other').n, 1);
});
