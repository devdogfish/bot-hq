import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Hono } from 'hono';

const recipients = ['owner@example.net', 'updates@example.net', 'inbox@example.net'];
Object.assign(process.env, {
  SESSION_SECRET: 'test-only-owner-email-session',
  DB_PATH: ':memory:',
  DEV_LOGIN: '1',
  ALLOWED_EMAILS: '',
  HQ_LOCAL_ENGINES: '0',
  HQ_OWNER_EMAIL_FROM_DOMAIN: 'example.org',
  HQ_OWNER_EMAIL_TO: JSON.stringify(recipients),
  BOT_HQ_EMAIL_SES_ACCESS_KEY_ID: 'test-access-key',
  BOT_HQ_EMAIL_SES_SECRET_ACCESS_KEY: 'test-secret-key',
});

const { api } = await import('../server/dist/routes.js');
const { mcpApi } = await import('../server/dist/mcp.js');
const { db } = await import('../server/dist/db.js');
const { mcpToken } = await import('../server/dist/engine.js');
const { enqueue, isBotBusy } = await import('../server/dist/agent/loop.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents();
initRooms();

async function until(expectation, message) {
  const deadline = Date.now() + 4000;
  do {
    const result = await expectation();
    if (result) return result;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(message);
}

test('Owner chat sends once, approval shows the exact mail, and other turns cannot send', async (t) => {
  const hq = new Hono();
  hq.route('/api', api);
  hq.route('/mcp', mcpApi);
  const encoded = new TextEncoder();
  let run;
  let runCount = 0;
  const emit = (type, data = {}) => run.stream.enqueue(encoded.encode(
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
  ));
  const finish = (type = 'run.completed') => {
    emit(type);
    run.stream.close();
  };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://127.0.0.1:29653', 'unexpected network request');
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'tyler' }] });
    if (url.pathname === '/v1/runs' && options.method === 'POST') {
      const { input: chat } = JSON.parse(options.body);
      run = { id: 'test-run-' + ++runCount, requestId: /Use request_id "([^"]+)"/.exec(chat)?.[1] };
      return Response.json({ run_id: run.id });
    }
    if (url.pathname === `/v1/runs/${run.id}/events`) {
      return new Response(new ReadableStream({
        start(controller) { run.stream = controller; },
      }));
    }
    if (url.pathname === `/v1/runs/${run.id}/stop`) {
      finish('run.cancelled');
      return Response.json({ ok: true });
    }
    assert.fail('unexpected gateway API path: ' + url.pathname);
  });
  const attempted = [];
  let providerUncertain = false;
  t.mock.method(SESv2Client.prototype, 'send', async (command) => {
    attempted.push(command.input);
    if (providerUncertain) throw new Error('synthetic lost acknowledgement');
    return { MessageId: `fixture-${attempted.length}` };
  });

  const headers = { 'content-type': 'application/json' };
  const login = await hq.request('/api/auth/dev', {
    method: 'POST', headers, body: JSON.stringify({ email: 'tester@example.net' }),
  });
  assert.equal(login.status, 200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  async function apiRequest(path, method = 'GET', body, status = 200) {
    const response = await hq.request('/api' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reply = await response.json();
    assert.equal(response.status, status, JSON.stringify(reply));
    return reply;
  }

  const { bots: [bot] } = await apiRequest('/bots');
  const { bot: other } = await apiRequest('/bots', 'POST', { name: 'Other' });
  const path = '/bots/' + bot.id;
  db.prepare('UPDATE bots SET hermes_url=?,hermes_key=? WHERE id=?')
    .run('http://127.0.0.1:29653', 'test-only-gateway-bearer', bot.id);
  process.env.HQ_OWNER_EMAIL_TARGETS = JSON.stringify({ tyler: bot.id });

  async function rpc(id, method, params) {
    const response = await hq.request('/mcp/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + mcpToken(id) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }

  async function call(args) {
    const reply = await rpc(bot.id, 'tools/call', { name: 'send_owner_email', arguments: args });
    return JSON.parse(reply.content[0].text);
  }
  const fields = { subject: 'Synthetic status', body: 'First line.\nSecond line.' };
  let calls = 0;
  function announce(tool = 'mcp__hq__send_owner_email') {
    emit('tool.started', { tool, tool_call_id: 'fixture-mail-call-' + ++calls, preview: 'Synthetic status' });
  }
  async function waitTurn(before) {
    return until(() => runCount > before && run.stream && run, 'gateway did not start the expected turn');
  }
  async function chat(text) {
    const before = runCount;
    await apiRequest(path + '/messages', 'POST', { text });
    return waitTurn(before);
  }
  const readRows = async () => (await apiRequest(path + '/rows')).rows;
  const pendingCard = async () => (await readRows()).find(({ body }) => body.card === 'approval' && body.status === 'pending');
  const idle = () => until(() => !isBotBusy(bot.id), 'Bot HQ turn did not finish');

  assert((await rpc(bot.id, 'tools/list')).tools.some((tool) => tool.name === 'send_owner_email'));
  assert(!(await rpc(other.id, 'tools/list')).tools.some((tool) => tool.name === 'send_owner_email'));
  assert.deepEqual(await call({ ...fields, request_id: 'outside-turn' }), { status: 'draft_only' });

  let turn = await chat('Please email me the status.');
  assert.ok(turn.requestId);
  announce('mcp__elsewhere__send_owner_email');
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId }), { status: 'draft_only' });
  announce();
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId, to: 'outside@example.net' }), { status: 'draft_only' });
  assert.deepEqual(await call({ ...fields, request_id: 'wrong' }), { status: 'draft_only' });
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId }), { status: 'accepted', messageId: 'fixture-1' });
  assert.deepEqual(attempted[0].Destination, { ToAddresses: recipients });
  assert.equal(attempted[0].FromEmailAddress, 'tyler@example.org');
  assert.equal(await pendingCard(), undefined);
  announce();
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId }), { status: 'accepted', messageId: 'fixture-1' });
  announce();
  assert.deepEqual(await call({ ...fields, body: 'Changed mail', request_id: turn.requestId }), { status: 'conflict' });
  assert.equal(attempted.length, 1);
  finish();
  await idle();

  turn = await chat('Email me at owner@example.net with the status.');
  assert.ok(turn.requestId);
  announce();
  const review = call({ ...fields, request_id: turn.requestId });
  const { body: card } = await until(pendingCard, 'subset request must show the whole distribution');
  assert.equal(card.detail, `From: tyler@example.org\nTo: ${recipients.join(', ')}\nSubject: ${fields.subject}\n\n${fields.body}`);
  assert.equal(attempted.length, 1);
  await apiRequest('/approvals/' + card.approvalId, 'POST', { decision: 'allow' });
  assert.deepEqual(await review, { status: 'accepted', messageId: 'fixture-2' });
  assert.equal(attempted[1].Content.Simple.Body.Text.Data, fields.body);
  finish();
  await idle();

  turn = await chat('Email me at owner@example.net with a different status.');
  announce();
  const stopped = call({ ...fields, request_id: turn.requestId });
  await until(pendingCard, 'expected an email approval before pause');
  await apiRequest(path + '/pause', 'PATCH', { paused: true });
  assert.deepEqual(await stopped, { status: 'skipped' });
  await idle();
  assert.equal(attempted.length, 2);
  await apiRequest(path + '/pause', 'PATCH', { paused: false });

  const priorRun = runCount;
  assert(enqueue(bot.id, { type: 'routine', routineId: 'test', name: 'Digest', prompt: 'Email me the status.' }));
  turn = await waitTurn(priorRun);
  assert.equal(turn.requestId, undefined);
  announce();
  assert.deepEqual(await call({ ...fields, request_id: 'routine-token' }), { status: 'draft_only' });
  assert.equal(await pendingCard(), undefined);
  finish();
  await idle();

  providerUncertain = true;
  turn = await chat('Send me an email with the latest status.');
  announce();
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId }), { status: 'uncertain' });
  announce();
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId }), { status: 'uncertain' });
  assert.equal(attempted.length, 3);
  finish();
  await idle();
  assert.deepEqual(await call({ ...fields, request_id: turn.requestId }), { status: 'draft_only' });
});
