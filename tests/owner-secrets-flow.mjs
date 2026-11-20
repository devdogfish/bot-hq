import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

const appOrigin = 'https://hq.example.net';
const gateway = 'http://127.0.0.1:29653';
const agentToken = 'fixture-only-agent-token';
const fields = {
  username: 'fixture-private-username',
  password: 'fixture-private-password',
  totp: 'JBSWY3DPEHPK3PXP',
};
const ref = '01234567-89ab-cdef-0123-456789abcdef';

Object.assign(process.env, {
  SESSION_SECRET: 'test-only-owner-secrets-session',
  DB_PATH: ':memory:',
  DEV_LOGIN: '1',
  ALLOWED_EMAILS: '',
  HQ_LOCAL_ENGINES: '0',
  APP_URL: appOrigin,
});

const { api } = await import('../server/dist/routes.js');
const { configApi } = await import('../server/dist/routes-config.js');
const { secureInputApi } = await import('../server/dist/routes-secure-input.js');
const { mcpApi } = await import('../server/dist/mcp.js');
const { db } = await import('../server/dist/db.js');
const { mcpToken } = await import('../server/dist/engine.js');
const { isBotBusy } = await import('../server/dist/agent/loop.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents();
initRooms();

async function until(check, message) {
  const deadline = Date.now() + 4000;
  do {
    const result = await check();
    if (result) return result;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(message);
}

test('Owner secure input forwards values only to the assigned Agent and supports decline and revoke', async (t) => {
  const hq = new Hono();
  hq.route('/api', secureInputApi);
  hq.route('/api', api);
  hq.route('/api', configApi);
  hq.route('/mcp', mcpApi);
  const runs = [];
  const mcpReplies = [];
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(...args.map(String)));
  }
  const agentRequests = [];
  const receipt = Promise.withResolvers();
  const release = Promise.withResolvers();
  const encoder = new TextEncoder();
  let saved;
  const agentErrors = [];
  const agentServer = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + agentToken);
      const { method, url: path } = request;
      agentRequests.push({ method, path });
      if (method === 'POST' && path === '/v1/owner-secrets') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { fields: forwarded, ...metadata } = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(forwarded, fields);
        const { request_id, ...listing } = metadata;
        const { kind, site } = listing;
        saved = { ...listing, ref, expires_at: null };
        receipt.resolve(request_id);
        await release.promise;
        response.statusCode = 201;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ref, kind, site, expires_at: null }));
      } else if (method === 'GET' && path === '/v1/owner-secrets') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(saved ? [{ ...saved, fields }] : []));
      } else if (method === 'DELETE' && path === '/v1/owner-secrets/' + ref) {
        saved = undefined;
        response.writeHead(204).end();
      } else {
        assert.fail('Unexpected Agent endpoint ' + method + ' ' + path);
      }
    } catch (error) {
      agentErrors.push(error);
      response.writeHead(500).end();
    }
  });
  agentServer.listen(0, '127.0.0.1');
  await once(agentServer, 'listening');
  t.after(async () => {
    release.resolve();
    await new Promise((resolve) => agentServer.close(resolve));
    assert.deepEqual(agentErrors, []);
  });
  const agentPort = agentServer.address().port;
  const agent = 'http://127.0.0.1:' + agentPort;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    const method = options?.method ?? 'GET';
    if (url.origin === agent) return fetch(input, options);
    assert.equal(url.origin, gateway, 'unexpected network request');
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'tyler' }] });
    if (url.pathname === '/v1/runs' && method === 'POST') {
      const run = { id: 'fixture-run-' + (runs.length + 1), input: JSON.parse(options.body).input };
      runs.push(run);
      return Response.json({ run_id: run.id });
    }
    const run = runs.find(({ id }) => url.pathname.startsWith('/v1/runs/' + id));
    if (run && url.pathname.endsWith('/events')) {
      return new Response(new ReadableStream({
        start(controller) { run.stream = controller; },
      }));
    }
    if (run && url.pathname === '/v1/runs/' + run.id) {
      return Response.json({ run_id: run.id, session_id: 'fixture-session' });
    }
    if (url.pathname === '/api/sessions/fixture-session/messages') return Response.json({ data: [] });
    assert.fail('Unexpected Hermes endpoint ' + method + ' ' + url.pathname);
  });

  const headers = { 'content-type': 'application/json', origin: appOrigin };
  async function login(email) {
    const response = await hq.request('/api/auth/dev', {
      method: 'POST', headers, body: JSON.stringify({ email }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const otherCookie = await login('another-owner@example.net');
  headers.cookie = await login('tester@example.net');

  async function request(path, method = 'GET', body, requestHeaders = headers) {
    const response = await hq.request('/api' + path, {
      method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  }

  const { body: { bots: [bot] } } = await request('/bots');
  const botPath = '/bots/' + bot.id;
  const configPath = '/config/bots/' + bot.id + '/owner-secrets';
  const agentSettings = await request(botPath + '/agent', 'PUT', {
    hermesUrl: gateway, hermesKey: 'fixture-hermes-key', websockifyUrl: '', cdpPort: null,
    ownerSecretPort: agentPort, ownerSecretToken: agentToken,
  });
  assert.equal(agentSettings.status, 200);
  assert.equal(agentSettings.body.agent.ownerSecretPort, agentPort);
  assert.equal(agentSettings.body.agent.ownerSecretTokenSet, true);
  assert.ok(!JSON.stringify(agentSettings).includes(agentToken));

  const metadata = {
    kind: 'login', site: 'https://accounts.example.net', label: 'Example account',
    reason: 'Sign in to look up the Owner’s account', one_time: false,
  };
  async function callSecureInput(args) {
    const response = await hq.request('/mcp/' + bot.id, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + mcpToken(bot.id) },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'request_secure_input', arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    mcpReplies.push(result);
    return result;
  }
  assert.equal((await callSecureInput(metadata)).isError, true);

  const stream = (index) => until(() => runs[index]?.stream, 'Hermes event stream did not start');
  async function finish(index) {
    const controller = await stream(index);
    controller.enqueue(encoder.encode('event: run.completed\ndata: {}\n\n'));
    controller.close();
    await until(() => !isBotBusy(bot.id), 'Bot HQ turn did not finish');
  }
  async function readCard(id) {
    const { body: { rows } } = await request(botPath + '/rows');
    return rows.map(({ body }) => body).find(({ requestId }) => requestId === id);
  }
  async function openCard(index) {
    assert.equal((await request(botPath + '/messages', 'POST', { text: 'Open secure input.' })).status, 200);
    await stream(index);
    assert.equal((await callSecureInput({ ...metadata, site: metadata.site + '/login' })).isError, true);
    const reply = await callSecureInput({ ...metadata, site: 'https://Accounts.example.net:443/' });
    assert.ok(!reply.isError, JSON.stringify(reply));
    const receipt = JSON.parse(reply.content[0].text);
    assert.equal(typeof receipt.request_id, 'string');
    assert.deepEqual(receipt, { request_id: receipt.request_id, status: 'pending' });
    const card = await readCard(receipt.request_id);
    assert.ok(card);
    assert.equal(card.type, 'card');
    assert.equal(card.card, 'secure-input');
    assert.equal(card.status, 'pending');
    assert.equal(card.oneTime, metadata.one_time);
    for (const key of ['kind', 'site', 'label', 'reason']) assert.equal(card[key], metadata[key]);
    await finish(index);
    return receipt.request_id;
  }

  const id = await openCard(0);
  const submission = { decision: 'submit', fields };
  const decisionPath = '/secure-input/' + id;
  const { cookie: _, ...anonymous } = headers;
  assert.equal((await request(decisionPath, 'POST', submission, anonymous)).status, 401);
  assert.equal((await request(decisionPath, 'POST', submission, { ...headers, origin: 'https://other.example.net' })).status, 403);
  assert.ok([403, 404].includes((await request(decisionPath, 'POST', submission, { ...headers, cookie: otherCookie })).status));
  assert.equal((await request(decisionPath, 'POST', { ...submission, fields: { ...fields, password: 'x'.repeat(65536) } })).status, 413);
  assert.deepEqual(agentRequests, []);

  const submitting = request(decisionPath, 'POST', submission);
  assert.equal(await Promise.race([receipt.promise, delay(4000, 'timed out', { ref: false })]), id);
  assert.equal((await request(decisionPath, 'POST', submission)).status, 409);
  assert.equal((await request(decisionPath, 'POST', { decision: 'decline' })).status, 409);
  assert.equal((await readCard(id)).status, 'pending');
  release.resolve();
  assert.deepEqual(await submitting, {
    status: 200, body: { status: 'ready', ref },
  });
  assert.equal((await readCard(id)).status, 'ready');
  assert.deepEqual(saved, {
    kind: metadata.kind, site: metadata.site, label: metadata.label,
    one_time: false, ref, expires_at: null,
  });
  await stream(1);
  assert.ok(runs[1].input.includes(id));
  assert.ok(runs[1].input.includes('ready'));
  assert.ok(runs[1].input.includes(ref));
  await finish(1);
  await request(decisionPath, 'POST', submission);
  assert.deepEqual(agentRequests, [{ method: 'POST', path: '/v1/owner-secrets' }]);

  const declineId = await openCard(2);
  assert.equal((await request(botPath + '/pause', 'PATCH', { paused: true })).status, 200);
  assert.deepEqual(await request('/secure-input/' + declineId, 'POST', { decision: 'decline' }), {
    status: 200, body: { status: 'declined' },
  });
  assert.equal((await readCard(declineId)).status, 'declined');
  assert.equal(runs.length, 3);
  assert.equal((await request(botPath + '/pause', 'PATCH', { paused: false })).status, 200);
  await stream(3);
  assert.ok(runs[3].input.includes(declineId));
  assert.ok(runs[3].input.includes('declined'));
  await finish(3);
  assert.equal(agentRequests.length, 1);

  const listing = await request(configPath);
  assert.equal(listing.status, 200);
  assert.ok(JSON.stringify(listing.body).includes(ref));
  assert.ok([403, 404].includes((await request(configPath, 'GET', undefined, { ...headers, cookie: otherCookie })).status));
  const revokePath = configPath + '/' + ref;
  assert.equal((await request(revokePath, 'DELETE', undefined, { ...headers, origin: 'https://other.example.net' })).status, 403);
  assert.equal((await request(revokePath, 'DELETE')).status, 204);
  assert.deepEqual(await request(configPath), { status: 200, body: [] });
  assert.deepEqual(agentRequests, [
    { method: 'POST', path: '/v1/owner-secrets' },
    { method: 'GET', path: '/v1/owner-secrets' },
    { method: 'DELETE', path: '/v1/owner-secrets/' + ref },
    { method: 'GET', path: '/v1/owner-secrets' },
  ]);

  const { body: chat } = await request(botPath + '/rows');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
  const snapshot = tables.map(({ name }) => db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all());
  const observed = JSON.stringify({ chat, snapshot, logs, listing, mcpReplies, prompts: runs.map(({ input }) => input) });
  for (const value of Object.values(fields)) assert.ok(!observed.includes(value), 'private input leaked to chat, storage, logs, listing or Hermes');
});
