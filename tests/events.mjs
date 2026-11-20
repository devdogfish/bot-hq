import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
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
const { isBotBusy, personalTool, resetBotQueue, setBotPaused } = await import('../server/dist/agent/loop.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
const { setRoutineEnabled } = await import('../server/dist/routines.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
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
function hookRequest(body, { routine = 'inbox', botId = 'bot', bearer = token(botId), headers = {} } = {}) {
  return [`/hooks/${botId}/${encodeURIComponent(routine)}`, {
    method: 'POST',
    headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), 'content-type': 'application/json', ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  }];
}

function post(payload, options) {
  return app.request(...hookRequest(JSON.stringify(payload), options));
}

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  assert.fail('Timed out waiting for event turn');
}

test('hook authenticates the Bot and matches only enabled event schedules', async () => {
  for (const routine of ['inbox', 'unknown', 'disabled']) {
    for (const bearer of [null, '0'.repeat(63), '0'.repeat(64)]) {
      const response = await app.request(...hookRequest('invalid JSON', { routine, bearer }));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    }
  }
  assert.equal((await post(event(0), { botId: 'missing', bearer: token('bot') })).status, 401);
  assert.equal((await post(event(0), { botId: 'other', bearer: token('bot') })).status, 401);
  assert.equal((await post(event(0), { bearer: mcpToken('bot') })).status, 401);
  for (const routine of ['unknown', 'disabled', 'Daily']) {
    assert.equal((await post(event(0), { routine })).status, 404);
  }
  assert.equal((await post(event(0), { botId: 'missing' })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_events').get().n, 0);
});

test('hook enforces the byte limit on actual bytes before parsing JSON', async () => {
  assert.equal((await app.request(...hookRequest('{unfinished'))).status, 400);
  assert.equal((await post({ ...event(0), refs: 'history:0' })).status, 400);
  assert.equal((await post({ ...event(0), event_id: '\ud800' })).status, 400);
  const exact = JSON.stringify({ ...event(0), summary: '' });
  const atLimit = JSON.stringify({ ...event(0), summary: 'x'.repeat(16 * 1024 - exact.length) });
  assert.equal(Buffer.byteLength(atLimit), 16 * 1024);
  assert.equal((await app.request(...hookRequest(atLimit, { routine: 'unknown' }))).status, 404);
  assert.equal((await app.request(...hookRequest('{', { headers: { 'content-length': '16385' } }))).status, 413);

  for (const headers of [{}, { 'content-length': '10' }]) {
    let cancelled = false;
    const bytes = new TextEncoder().encode(`{${'é'.repeat(8192)}`);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8192));
        controller.enqueue(bytes.subarray(8192));
      },
      cancel() { cancelled = true; },
    });
    const response = await app.request(...hookRequest(stream, { headers }));
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
  }
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
  events[0].refs = { uidvalidity: 4, uid: 11 };
  const startedAt = performance.now();
  const responses = await Promise.all([...events, { ...event(1), summary: 'Duplicate payload' }].map((payload) => post(payload)));
  assert.deepEqual(responses.slice(0, 5).map(({ status }) => status), [202, 202, 202, 202, 202]);
  const duplicate = responses[5];
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
  assert.equal((await post(event(1), { botId: 'other' })).status, 200, 'a retry keeps its receipt after disabling the routine');
});

test('pause and reset invalidate pending batches and leave only accepted IDs', async () => {
  assert.equal(enqueueEvent('bot', 'inbox', event('before-pause')), 'accepted');
  setBotPaused('bot', true);
  setBotPaused('bot', false);
  assert.equal(enqueueEvent('bot', 'inbox', event('before-reset')), 'accepted');
  const maintenance = Promise.withResolvers();
  const reset = resetBotQueue('bot', () => maintenance.promise);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_batches').get().n, 0);
  assert.equal(enqueueEvent('bot', 'inbox', event('busy-reset')), 'unavailable');
  maintenance.resolve();
  await reset;
  await until(() => !isBotBusy('bot'));
  assert.equal(enqueueEvent('bot', 'inbox', event('before-pause')), 'duplicate');
  assert.equal(enqueueEvent('bot', 'inbox', event('before-reset')), 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_routine_events').get().n, 0);
  assert.equal(listRows('bot').filter(({ body }) => body.event === 'routine-run').length, 2);
});

test('event schedules can be provisioned and edited through routine tools', async () => {
  const ctx = { botId: 'bot', userId: 'team' };
  const create = toolMap.get('create_routine').impl;
  const update = toolMap.get('update_routine').impl;
  assert.match((await create({ name: 'Invalid', prompt: 'Check.', schedule: 'event:' }, ctx)).output, /Invalid schedule/);
  const { routine } = JSON.parse((await create({
    name: 'Jobs inbox monitoring', prompt: 'Check new messages.', schedule: 'event:Jobs inbox monitoring',
  }, ctx)).output);
  assert.equal(routine.description, 'Event: Jobs inbox monitoring');
  assert.equal(routine.nextRunAt, null);
  const edited = JSON.parse((await update({ routine_id: routine.id, prompt: 'Only use the references.' }, ctx)).output);
  assert.equal(edited.routine.prompt, 'Only use the references.');
  assert.equal((await post(event('jobs'), { routine: 'Jobs inbox monitoring' })).status, 202);
  await resetBotQueue('bot', () => {});
});

test('a full batch rejects new IDs without recording receipts', async () => {
  // Synchronous calls keep all deliveries in one batch, regardless of runner load.
  const completed = Array.from({ length: 64 }, (_, id) => enqueueEvent('bot', 'inbox', event(`batch-${id}`)));
  assert.deepEqual(completed, Array(64).fill('accepted'));
  assert.equal(enqueueEvent('bot', 'inbox', event('batch-64')), 'unavailable');
  assert.equal(enqueueEvent('bot', 'inbox', event('batch-0')), 'duplicate');
  assert.equal(db.prepare('SELECT 1 FROM seen_events WHERE bot_id=? AND event_id=?').get('bot', 'mail:batch-64'), undefined);
  await resetBotQueue('bot', () => {});

  const large = (id) => ({ ...event(id), summary: 'é'.repeat(8000) });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(enqueueEvent('bot', 'inbox', large(id)), 'accepted');
  assert.equal(enqueueEvent('bot', 'inbox', large('e')), 'unavailable');
  assert.equal(db.prepare('SELECT 1 FROM seen_events WHERE bot_id=? AND event_id=?').get('bot', 'mail:e'), undefined);
  await resetBotQueue('bot', () => {});
});

test('private Gmail event runs in its own session without Owner chat tool access', async (t) => {
  const privateGateway = 'https://private-event.example.test';
  Object.assign(process.env, {
    HQ_TYLER_PERSONAL_BOT_ID: 'bot_personal',
    HQ_TYLER_PERSONAL_GATEWAY_ORIGIN: privateGateway,
    HQ_OWNER_EMAIL_TARGETS: JSON.stringify({ tyler: 'bot_business' }),
    HQ_OWNER_EMAIL_FROM_DOMAIN: 'example.test',
    HQ_OWNER_EMAIL_TO: JSON.stringify(['one@example.test', 'two@example.test', 'three@example.test']),
    BOT_HQ_EMAIL_SES_ACCESS_KEY_ID: 'test-ses-access-key',
    BOT_HQ_EMAIL_SES_SECRET_ACCESS_KEY: 'test-ses-secret-key',
    HQ_TYLER_GMAIL_MAILBOX: 'one@example.test',
    HQ_TYLER_GMAIL_CLIENT_ID: 'test-client',
    HQ_TYLER_GMAIL_CLIENT_SECRET: 'test-client-secret',
    HQ_TYLER_GMAIL_REFRESH_TOKEN: 'test-refresh-token',
  });
  db.exec(`
    INSERT INTO bots (id, user_id, name, hermes_url, hermes_key, created_at, updated_at)
      VALUES ('bot_business', 'team', 'Business', '${gateway}', 'business-key', 0, 0),
             ('bot_personal', 'team', 'Personal', '${privateGateway}', 'personal-key', 0, 0);
    INSERT INTO routines (id, bot_id, name, prompt, schedule, created_at)
      VALUES ('gmail', 'bot_personal', 'Gmail new mail', 'Triage Gmail metadata.', 'event:Gmail new mail', 0),
             ('personal-other', 'bot_personal', 'Other', 'Other task.', 'event:other', 0);
  `);
  const runs = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, privateGateway);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'fixture' }] });
    if (url.pathname === '/v1/runs') {
      runs.push({ ...JSON.parse(options.body), session: options.headers['x-hermes-session-key'] });
      assert.deepEqual(await personalTool('bot_personal', 'read_personal_gmail', { messageId: '123' }), { status: 'unavailable' });
      return Response.json({ run_id: 'gmail' });
    }
    assert.equal(url.pathname, '/v1/runs/gmail/events');
    return new Response('event: run.completed\ndata: {}\n\n');
  });
  const payload = { ...event('gmail'), refs: { messageId: '123' } };
  assert.equal((await post(payload, { botId: 'bot_personal', routine: 'Gmail new mail' })).status, 404);
  assert.equal(enqueueEvent('bot_personal', 'other', payload), 'unavailable');
  assert.equal(enqueueEvent('bot_personal', 'Gmail new mail', payload), 'accepted');
  await until(() => !isBotBusy('bot_personal'));
  assert.equal(runs.length, 1);
  assert.match(runs[0].session, /^hq-gmail-event_/);
  assert.match(runs[0].input, /"messageId":"123"/);
  assert.match(runs[0].instructions, /untrusted data/);
  assert.equal(listRows('bot_personal')[0].body.event, 'routine-run');
});

const exec = promisify(execFile);

test('two processes race for one ID and a fresh HQ recovers the accepted payload once', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-hq-event-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runs = [];
  const gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    if (req.url === '/v1/runs') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      runs.push(JSON.parse(Buffer.concat(chunks)));
      return res.end(JSON.stringify({ run_id: 'recovered' }));
    }
    if (req.url === '/v1/runs/recovered/events') {
      res.setHeader('content-type', 'text/event-stream');
      return res.end('event: run.completed\ndata: {}\n\n');
    }
    res.writeHead(404).end();
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => gateway.close());
  const childEnv = {
    ...process.env, DB_PATH: join(dir, 'hq.db'), PORT: '0', HQ_HOST: '127.0.0.1', GROKBOT_NO_SCHEDULER: '1',
  };
  await exec(process.execPath, ['--input-type=module', '-e', `
    const { db } = await import('./server/dist/db.js');
    db.exec(\`
      INSERT INTO users (id,email,name,created_at) VALUES ('owner', 'restart@example.test', 'Owner', 0);
      INSERT INTO bots (id,user_id,name,hermes_url,hermes_key,created_at,updated_at)
        VALUES ('restart', 'owner', 'Restart', 'http://127.0.0.1:${gateway.address().port}', 'test-key', 0, 0);
      INSERT INTO routines (id,bot_id,name,prompt,schedule,created_at)
        VALUES ('rt', 'restart', 'Inbox', 'Handle arrivals.', 'event:inbox', 0);
    \`);
  `], { env: childEnv });
  const payload = { event_id: 'restart:1', summary: 'Persisted before exit', refs: { messageId: 'recovery' } };
  const accept = () => exec(process.execPath, ['--input-type=module', '-e', `
    const { writeSync } = await import('node:fs');
    const { enqueueEvent } = await import('./server/dist/events.js');
    writeSync(1, enqueueEvent('restart', 'inbox', ${JSON.stringify(payload)}));
    process.exit(0);
  `], { env: childEnv });
  const raced = await Promise.all([accept(), accept()]);
  assert.deepEqual(raced.map(({ stdout }) => stdout).sort(), ['accepted', 'duplicate']);
  const sqlite = new Database(childEnv.DB_PATH, { readonly: true });
  t.after(() => sqlite.close());
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_routine_events').get().n, 1);

  async function startHQ() {
    const hq = spawn(process.execPath, ['server/dist/index.js'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(hq, 'exit');
    const stop = async () => { hq.kill(); await exit; };
    t.after(stop);
    let logs = '';
    const collect = (chunk) => { logs += chunk.toString(); };
    hq.stdout.on('data', collect);
    hq.stderr.on('data', collect);
    const port = await until(() => /server on http:\/\/localhost:(\d+)/.exec(logs)?.[1], 7000);
    return { origin: `http://127.0.0.1:${port}`, stop, logs: () => logs };
  }
  const first = await startHQ();
  await until(() => runs.length === 1);
  assert.match(runs[0].input, /Persisted before exit/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_routine_events').get().n, 0);
  await first.stop();

  const restarted = await startHQ();
  const [path, init] = hookRequest(JSON.stringify(payload), { botId: 'restart' });
  const response = await fetch(restarted.origin + path, init);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'duplicate' });
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024));
      controller.enqueue(new Uint8Array(9 * 1024));
      controller.close();
    },
  });
  const [largePath, largeInit] = hookRequest(oversized, { botId: 'restart' });
  assert.equal((await fetch(restarted.origin + largePath, largeInit)).status, 413);
  assert.equal(runs.length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM seen_events').get().n, 1);
  assert.equal((first.logs() + restarted.logs()).includes(token('restart')), false);
});

test('archived Bots and rooms cannot accept events', () => {
  db.prepare('UPDATE bots SET archived_at=1 WHERE id=?').run('bot');
  try {
    assert.equal(enqueueEvent('bot', 'inbox', event('archived')), 'unavailable');
  } finally {
    db.prepare('UPDATE bots SET archived_at=NULL WHERE id=?').run('bot');
  }
  db.prepare("UPDATE bots SET kind='room' WHERE id=?").run('bot');
  try {
    assert.equal(enqueueEvent('bot', 'inbox', event('room')), 'unavailable');
  } finally {
    db.prepare("UPDATE bots SET kind='agent' WHERE id=?").run('bot');
  }
  assert.equal(db.prepare("SELECT 1 FROM seen_events WHERE event_id IN ('mail:archived','mail:room')").get(), undefined);
});

test('event turns respect routine re-enable revisions and auto-pause after failures', async (t) => {
  let submissions = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, gateway);
    if (url.pathname === '/v1/runs') {
      submissions++;
      return Response.json({ run_id: 'failure' });
    }
    assert.equal(url.pathname, '/v1/runs/failure/events');
    return new Response('event: run.failed\ndata: {"error":"fixture failure"}\n\n');
  });
  t.mock.method(console, 'error', () => {});
  assert.equal(enqueueEvent('bot', 'other', event('old-revision')), 'accepted');
  setRoutineEnabled('rt2', false);
  setRoutineEnabled('rt2', true);
  await until(() => !isBotBusy('bot'));
  assert.equal(submissions, 0);
  for (let n = 1; n <= 3; n++) {
    assert.equal(enqueueEvent('bot', 'other', event(`failure-${n}`)), 'accepted');
    await until(() => !isBotBusy('bot'));
    assert.equal(submissions, n);
  }
  assert.deepEqual(db.prepare('SELECT enabled, consecutive_failures FROM routines WHERE id=?').get('rt2'), {
    enabled: 0, consecutive_failures: 3,
  });
  assert.equal(enqueueEvent('bot', 'other', event('failure-4')), 'not_found');
});
