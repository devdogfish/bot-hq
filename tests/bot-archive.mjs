import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Cron } from 'croner';
import { Hono } from 'hono';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'loopback-archive-test';
process.env.DEV_LOGIN = '1';
process.env.APP_URL = 'http://localhost';
process.env.ALLOWED_EMAILS = '';
process.env.HQ_LOCAL_ENGINES = '0';

const { db } = await import('../server/dist/db.js');
const { api } = await import('../server/dist/routes.js');
const { mcpApi } = await import('../server/dist/mcp.js');
const { mcpToken, engineInfo } = await import('../server/dist/engine.js');
const { enqueue } = await import('../server/dist/agent/loop.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
const { initRoutines, runRoutine, unscheduleRoutine } = await import('../server/dist/routines.js');
const app = new Hono().route('/api', api).route('/mcp', mcpApi);
initSubagents();
initRooms();

async function request(path, { cookie = '', method = 'GET', body, status = 200 } = {}) {
  const response = await app.request('/api' + path, {
    method, headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function login(email) {
  const { cookie } = await request('/auth/dev', { method: 'POST', body: { email } });
  return (path, options) => request(path, { cookie, ...options }).then(({ data }) => data);
}

test('parent links are explicit, stay within a roster and cannot create a cycle', async () => {
  const owner = await login('linker@example.test');
  const other = await login('other@example.test');
  const { bots: [parent] } = await owner('/bots');
  const { bots: [foreign] } = await other('/bots');
  const { bot: child } = await owner('/bots', { method: 'POST', body: { name: 'Linked' } });
  assert.equal(parent.parentBotId, null);
  assert.equal(child.parentBotId, null);
  assert.equal(child.archivedAt, null);

  const link = (id, parentBotId, status) => owner('/bots/' + id, { method: 'PATCH', body: { parentBotId }, status });
  await link(child.id, foreign.id, 400);
  await link(child.id, child.id, 400);
  assert.equal((await link(child.id, parent.id)).bot.parentBotId, parent.id);
  await link(parent.id, child.id, 400);
  await owner('/bots/' + parent.id, { method: 'DELETE' });
  assert.equal((await owner('/bots')).bots.find((bot) => bot.id === child.id).parentBotId, null);
});

test('archiving unschedules routines and unarchiving restores only previously enabled routines', async (t) => {
  const owner = await login('scheduler@example.test');
  const other = await login('other-scheduler@example.test');
  const { bots: [bot] } = await owner('/bots');
  const path = '/bots/' + bot.id;
  const stop = t.mock.method(Cron.prototype, 'stop');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-20T08:00:00Z') });
  const triggers = [];
  t.after(() => {
    unscheduleRoutine('on');
    db.prepare('DELETE FROM routines WHERE bot_id=?').run(bot.id);
  });
  const enqueueRoutine = (_id, trigger) => {
    triggers.push(trigger.routineId);
    return true;
  };
  initRoutines(enqueueRoutine);
  const insert = db.prepare(`
    INSERT INTO routines (id, bot_id, name, prompt, schedule, enabled, created_at)
    VALUES (?, ?, ?, 'Check reminders', '* * * * * *', 0, 0)
  `);
  insert.run('on', bot.id, 'Enabled routine');
  insert.run('off', bot.id, 'Disabled routine');
  await owner('/routines/on', { method: 'PATCH', body: { enabled: true } });
  db.prepare('UPDATE routines SET consecutive_failures=2 WHERE id=?').run('on');
  t.mock.timers.tick(1000);
  assert.deepEqual(triggers, ['on']);
  const timer = stop.mock.callCount();

  const archive = (archived, status) => owner(path + '/archive', { method: 'PATCH', body: { archived }, status });
  await other(path + '/archive', { method: 'PATCH', body: { archived: true }, status: 404 });
  assert((await archive(true)).bot.archivedAt > 0);
  assert.equal(stop.mock.callCount(), timer + 1, 'archive stops the real cron timer');
  await archive(true);
  assert.equal(stop.mock.callCount(), timer + 1, 'repeating archive is idempotent');
  const { bots, live } = await owner('/bots');
  assert(bots.some((entry) => entry.id === bot.id && entry.archivedAt));
  assert(!live.some((entry) => entry.botId === bot.id));
  const archivedRoutines = (await owner(path + '/routines')).routines;
  assert.equal(archivedRoutines.length, 2);
  assert(archivedRoutines.every((routine) => !routine.enabled && routine.nextRunAt === null));
  assert.equal(db.prepare('SELECT enabled FROM routines WHERE id=?').get('on').enabled, 1);
  await owner('/routines/on/run', { method: 'POST', status: 409 });
  runRoutine('on');
  await owner('/routines/off', { method: 'PATCH', body: { enabled: true }, status: 409 });
  initRoutines(enqueueRoutine); // A server start must also skip this archived Bot.
  t.mock.timers.tick(2000);
  assert.deepEqual(triggers, ['on']);

  assert.equal((await archive(false)).bot.archivedAt, null);
  const routines = new Map((await owner(path + '/routines')).routines.map((routine) => [routine.id, routine]));
  assert.equal(routines.get('on').enabled, true);
  assert(routines.get('on').nextRunAt > Date.now());
  assert.equal(routines.get('off').enabled, false);
  assert.equal(db.prepare('SELECT consecutive_failures FROM routines WHERE id=?').get('on').consecutive_failures, 2);
  t.mock.timers.tick(1000);
  assert.deepEqual(triggers, ['on', 'on']);
});

test('archive cancels the active gateway run and keeps bot data and pause state', { timeout: 10_000 }, async (t) => {
  const owner = await login('gateway@example.test');
  const { bots: [bot] } = await owner('/bots');
  const path = '/bots/' + bot.id;
  let streamOpened = Promise.withResolvers();
  let events;
  let stops = 0;
  let starts = 0;
  const gateway = createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/runs' && req.method === 'POST') {
      starts++;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"run_id":"archive-test"}');
    } else if (req.url === '/v1/runs/archive-test/events') {
      events = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      streamOpened.resolve();
    } else if (req.url === '/v1/runs/archive-test/stop') {
      stops++;
      res.writeHead(200).end();
      events.end('event: run.cancelled\ndata: {"type":"run.cancelled"}\n\n');
    } else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  await once(gateway, 'listening');
  const origin = 'http://127.0.0.1:' + gateway.address().port;
  db.prepare('UPDATE bots SET hermes_url=?, hermes_key=? WHERE id=?').run(origin, 'test-key', bot.id);
  initRoutines(enqueue);
  const { row } = await owner(path + '/messages', { method: 'POST', body: { text: 'In progress' } });
  await streamOpened.promise;

  const archive = (archived) => owner(path + '/archive', { method: 'PATCH', body: { archived } });
  await archive(true);
  assert.equal(stops, 1);
  assert.equal((await engineInfo(bot.id)).status, 'stopped');
  assert.equal(enqueue(bot.id, { type: 'user', text: 'Ignore' }), false);
  await owner(path + '/messages', { method: 'POST', body: { text: 'Blocked' }, status: 409 });
  const rpc = () => app.request('/mcp/' + bot.id, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + mcpToken(bot.id) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal((await rpc()).status, 409);
  assert.equal(starts, 1);
  assert.deepEqual((await owner(path + '/rows')).rows.find((entry) => entry.seq === row.seq), row);
  assert.equal(db.prepare('SELECT hermes_url FROM bots WHERE id=?').get(bot.id).hermes_url, origin);

  await owner(path + '/pause', { method: 'PATCH', body: { paused: true } });
  assert.equal((await archive(false)).bot.paused, true);
  assert.equal((await archive(true)).bot.paused, true);
  assert.equal((await archive(false)).bot.paused, true);
  await owner(path + '/pause', { method: 'PATCH', body: { paused: false } });
  assert.equal((await rpc()).status, 200);
  streamOpened = Promise.withResolvers();
  assert.equal((await owner(path + '/messages', { method: 'POST', body: { text: 'Active again' } })).row.body.text, 'Active again');
  await streamOpened.promise;
  assert.equal(starts, 2);
  await archive(true);
});
