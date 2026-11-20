import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

const appOrigin = 'https://hq.example.net';
const agentHost = '100.90.0.10';
const gateway = 'http://' + agentHost + ':29653';
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
const { hub } = await import('../server/dist/lib/hub.js');
const { readSecureInputReceipt } = await import('../server/dist/secure-input.js');
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
  const transcriptReads = [];
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
  let responseRef = ref;
  let responseExpiry = null;
  let rejectSubmission = false;
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
        assert.deepEqual(forwarded, metadata.kind === 'phone' ? { phone: '+15555550101' } : fields);
        if (rejectSubmission) {
          response.writeHead(400).end(JSON.stringify({ error: fields.password }));
          return;
        }
        const { request_id, ...listing } = metadata;
        const { kind, site } = listing;
        saved = { ...listing, ref, expires_at: null };
        receipt.resolve(request_id);
        await release.promise;
        response.statusCode = 201;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ref: responseRef, kind, site, expires_at: responseExpiry }));
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
  const agent = 'http://' + agentHost + ':' + agentPort;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    const method = options?.method ?? 'GET';
    if (url.origin === agent) return fetch('http://127.0.0.1:' + agentPort + url.pathname, options);
    assert.equal(url.origin, gateway, 'unexpected network request');
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'tyler' }] });
    if (url.pathname === '/v1/runs' && method === 'POST') {
      const run = { id: 'fixture-run-' + (runs.length + 1), input: JSON.parse(options.body).input, toolRows: [] };
      runs.push(run);
      return Response.json({ run_id: run.id });
    }
    const run = runs.find(({ id }) => url.pathname === '/v1/runs/' + id || url.pathname.startsWith('/v1/runs/' + id + '/'));
    if (run && url.pathname.endsWith('/events')) {
      return new Response(new ReadableStream({
        start(controller) { run.stream = controller; },
      }));
    }
    if (run && url.pathname === '/v1/runs/' + run.id) {
      transcriptReads.push('run');
      return Response.json({ run_id: run.id, session_id: run.id + '-session' });
    }
    const sessionRun = runs.find(({ id }) => url.pathname === '/api/sessions/' + id + '-session/messages');
    if (sessionRun) {
      transcriptReads.push('messages');
      return Response.json({ data: sessionRun.toolRows });
    }
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
  const events = [];
  const { user_id: userId } = db.prepare('SELECT user_id FROM bots WHERE id=?').get(bot.id);
  t.after(hub.subscribe(userId, (event) => events.push(event)));
  const botPath = '/bots/' + bot.id;
  const configPath = '/config/bots/' + bot.id + '/owner-secrets';
  const settings = {
    hermesUrl: gateway, hermesKey: 'fixture-hermes-key', websockifyUrl: '', cdpPort: null,
    ownerSecretPort: agentPort, ownerSecretToken: agentToken,
  };
  for (const host of ['127.0.0.1', '100.128.0.1', 'agent.example.net']) {
    const outsideTailnet = await request(botPath + '/agent', 'PUT', { ...settings, hermesUrl: 'http://' + host });
    assert.equal(outsideTailnet.status, 400);
  }
  const agentSettings = await request(botPath + '/agent', 'PUT', settings);
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
  async function openCard(index, cardMetadata = metadata) {
    assert.equal((await request(botPath + '/messages', 'POST', { text: 'Open secure input.' })).status, 200);
    const controller = await stream(index);
    const emit = (kind, data) => controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`));
    const tool = 'mcp__hq__request_secure_input';
    function complete(receipt, callId, { durable = false, source = tool } = {}) {
      const event = { tool: source, tool_call_id: callId };
      emit('tool.started', { ...event, preview: '' });
      emit('tool.completed', { ...event, preview: durable ? '' : receipt.content[0].text });
      if (durable) runs[index].toolRows.push({
        role: 'tool', tool_name: source, tool_call_id: callId,
        content: JSON.stringify({ result: receipt.content[0].text }),
      });
    }
    assert.equal((await callSecureInput({ ...metadata, site: metadata.site + '/login' })).isError, true);
    assert.equal((await callSecureInput({ ...metadata, site: 'https://accounts.example.net.' })).isError, true);
    const reply = await callSecureInput({ ...cardMetadata, site: 'https://Accounts.example.net:443/' });
    assert.ok(!reply.isError, JSON.stringify(reply));
    const receipt = JSON.parse(reply.content[0].text);
    assert.equal(typeof receipt.request_id, 'string');
    assert.deepEqual(receipt, { request_id: receipt.request_id, status: 'pending' });
    assert.equal(await readCard(receipt.request_id), undefined, 'an MCP bearer alone must not publish a card');
    complete(reply, 'secure-' + index, { durable: index === 0 });
    let secondId;
    let unrelatedId;
    if (index === 0) {
      const second = await callSecureInput(metadata);
      secondId = JSON.parse(second.content[0].text).request_id;
      complete(second, 'secure-second', { durable: true });
      const unrelated = await callSecureInput(metadata);
      unrelatedId = JSON.parse(unrelated.content[0].text).request_id;
      complete(unrelated, 'secure-unrelated', { source: 'mcp__other__request_secure_input' });
    }
    const readsBefore = transcriptReads.length;
    const finishStarted = performance.now();
    await finish(index);
    const finishMs = Math.round(performance.now() - finishStarted);
    if (index === 0) {
      assert.deepEqual(transcriptReads, ['run', 'messages'], 'verify multiple receipts in one session page');
      t.diagnostic(`Two deferred receipts: ${transcriptReads.length - readsBefore} mock gateway reads, ${finishMs} ms to settle`);
      assert.equal((await readCard(secondId))?.status, 'pending');
      assert.equal(await readCard(unrelatedId), undefined);
    } else {
      assert.equal(transcriptReads.length, readsBefore, 'inline receipts need no transcript requests');
      if (index === 2) t.diagnostic(`Inline receipt: 0 additional mock gateway reads, ${finishMs} ms to settle`);
    }
    const card = await readCard(receipt.request_id);
    assert.ok(card);
    assert.equal(card.type, 'card');
    assert.equal(card.card, 'secure-input');
    assert.equal(card.status, 'pending');
    assert.equal(card.oneTime, cardMetadata.one_time);
    for (const key of ['kind', 'site', 'label', 'reason']) assert.equal(card[key], cardMetadata[key]);
    return receipt.request_id;
  }

  const id = await openCard(0);
  const { body: { rows: currentRows } } = await request(botPath + '/rows');
  const { seq } = currentRows.find(({ body }) => body.requestId === id);
  assert.equal((await request(botPath + '/cards/' + seq + '/dismiss', 'POST')).status, 400);
  const submission = { decision: 'submit', fields };
  const decisionPath = '/secure-input/' + id;
  const { cookie: _, ...anonymous } = headers;
  assert.equal((await request(decisionPath, 'POST', submission, anonymous)).status, 401);
  const { origin: _origin, ...noOrigin } = headers;
  assert.equal((await request(decisionPath, 'POST', submission, noOrigin)).status, 403);
  assert.equal((await request(decisionPath, 'POST', submission, { ...headers, origin: 'https://other.example.net' })).status, 403);
  assert.ok([403, 404].includes((await request(decisionPath, 'POST', submission, { ...headers, cookie: otherCookie })).status));
  assert.equal((await request(decisionPath, 'POST', { ...submission, fields: { ...fields, password: 'x'.repeat(65536) } })).status, 413);
  assert.deepEqual(agentRequests, []);

  const submitting = request(decisionPath, 'POST', submission);
  assert.equal(await Promise.race([receipt.promise, delay(4000, 'timed out', { ref: false })]), id);
  assert.equal((await request(decisionPath, 'POST', submission)).status, 409);
  assert.equal((await request(decisionPath, 'POST', { decision: 'decline' })).status, 409);
  assert.equal((await request(botPath + '/agent', 'PUT', settings)).status, 409);
  assert.equal((await request(botPath + '/fresh', 'POST')).status, 409);
  assert.equal((await request(botPath, 'DELETE')).status, 409);
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

  const stale = await openCard(4);
  const changedPort = await request(botPath + '/agent', 'PUT', {
    ...settings, ownerSecretPort: agentPort === 65535 ? 65534 : agentPort + 1, ownerSecretToken: '',
  });
  assert.equal(changedPort.status, 200);
  assert.equal(changedPort.body.agent.ownerSecretTokenSet, false);
  assert.equal((await request(botPath + '/agent', 'PUT', settings)).status, 200);
  assert.equal((await request('/secure-input/' + stale, 'POST', submission)).status, 409);
  assert.equal(agentRequests.length, 4);

  const phone = '+15555550101';
  const phoneId = await openCard(5, { ...metadata, kind: 'phone', one_time: true });
  const phonePath = '/secure-input/' + phoneId;
  const phoneDecision = { decision: 'submit', fields: { phone }, one_time: true };
  responseRef = fields.password;
  assert.equal((await request(phonePath, 'POST', phoneDecision)).status, 502);
  assert.equal((await readCard(phoneId)).status, 'pending');
  assert.equal((await request(phonePath, 'POST', { decision: 'decline' })).status, 409);
  assert.equal((await request(phonePath, 'POST', { ...phoneDecision, one_time: false })).status, 409);
  assert.equal(agentRequests.length, 5);
  responseRef = ref;
  assert.equal((await request(phonePath, 'POST', phoneDecision)).status, 200);
  await finish(6);
  assert.equal(agentRequests.length, 6);

  const refused = await openCard(7);
  rejectSubmission = true;
  const rejection = await request('/secure-input/' + refused, 'POST', submission);
  assert.equal(rejection.status, 422);
  assert.ok(!JSON.stringify(rejection).includes(fields.password));
  assert.equal((await request('/secure-input/' + refused, 'POST', { decision: 'decline' })).status, 200);
  await finish(8);

  const expiredId = await openCard(9, { ...metadata, kind: 'phone', one_time: true });
  rejectSubmission = false;
  responseExpiry = new Date(Date.now() - 30_000).toISOString();
  assert.equal((await request('/secure-input/' + expiredId, 'POST', phoneDecision)).status, 410);
  assert.equal((await readCard(expiredId)).status, 'pending');
  assert.equal(runs.length, 10, 'an expired receipt must not trigger a ready notice');

  const { body: chat } = await request(botPath + '/rows');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
  const snapshot = tables.map(({ name }) => db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all());
  const observed = JSON.stringify({ chat, events, snapshot, logs, listing, mcpReplies, prompts: runs.map(({ input }) => input) });
  for (const value of [...Object.values(fields), phone]) assert.ok(!observed.includes(value), 'private input leaked to chat, storage, logs, listing or Hermes');
});

test('a UUID-shaped private value is never accepted as a vault receipt', async () => {
  const card = { kind: 'text', site: 'https://accounts.example.net' };
  const response = Response.json({ ...card, ref }, { status: 201 });
  assert.equal(await readSecureInputReceipt(response, card, [ref]), null);
});
