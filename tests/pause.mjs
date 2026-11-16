// Uses the isolated stock Hermes gateway and scripted model in docs/remote-agents.md.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';

const markerDir = process.env.HQ_TEST_MARKER_DIR;
assert(markerDir, 'Use the isolated Hermes test home for markers.');
const gateway = new URL(process.env.HQ_TEST_HERMES_URL ?? 'http://127.0.0.1:18762');
const gatewayKey = process.env.HQ_TEST_HERMES_KEY ?? 'hq-loopback-test';
const port = Number(process.env.HQ_TEST_PAUSE_PORT ?? 18764);
const origin = 'http://127.0.0.1:' + port;
const data = await mkdtemp(join(tmpdir(), 'bot-hq-pause-'));
const secret = 'isolated-pause-test';
const relays = [];
let hq;
let cookie;

const exists = (file) => access(join(markerDir, file)).then(() => true, () => false);
async function until(check, message) {
  const deadline = Date.now() + 15_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function startHq() {
  hq = spawn(process.execPath, ['server/dist/index.js'], {
    env: { ...process.env, PORT: String(port), DEV_LOGIN: '1', HQ_HOST: '127.0.0.1',
      APP_URL: origin, SESSION_SECRET: secret, HQ_DATA_DIR: data, DB_PATH: join(data, 'hq.db'),
      PRIMARY_BOT_NAME: 'Role A', HQ_LOCAL_ENGINES: '0', ALLOWED_EMAILS: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await until(async () => {
    assert.equal(hq.exitCode, null, 'Bot HQ exited before becoming ready');
    return fetch(origin + '/api/auth/me').then((r) => r.ok, () => false);
  }, 'Bot HQ did not start');
}

async function stopHq() {
  if (hq && hq.exitCode === null && hq.signalCode === null) {
    const exited = once(hq, 'exit');
    hq.kill('SIGTERM');
    await exited;
  }
}

async function login(email) {
  const res = await fetch(origin + '/api/auth/dev', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

async function api(url, method = 'GET', body, expected = 200, auth = cookie) {
  const res = await fetch(origin + '/api' + url, { method, headers: { cookie: auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json();
  assert.equal(res.status, expected, JSON.stringify(result));
  return result;
}

async function relay(key) {
  const runs = [];
  const server = createServer((incoming, outgoing) => {
    if (incoming.headers.authorization !== 'Bearer ' + key) {
      outgoing.writeHead(401).end();
      return;
    }
    const upstream = request(new URL(incoming.url, gateway), {
      method: incoming.method,
      headers: { ...incoming.headers, authorization: 'Bearer ' + gatewayKey, host: gateway.host },
    }, async (reply) => {
      outgoing.writeHead(reply.statusCode, reply.headers);
      if (incoming.method === 'POST' && incoming.url === '/v1/runs' && reply.statusCode < 300) {
        const chunks = [];
        for await (const chunk of reply) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        runs.push(JSON.parse(body).run_id);
        outgoing.end(body);
      } else reply.pipe(outgoing);
    });
    outgoing.on('close', () => upstream.destroy());
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  }).listen(0, '127.0.0.1');
  relays.push(server);
  await once(server, 'listening');
  return { url: 'http://127.0.0.1:' + server.address().port, runs };
}

async function hermesStatus(run) {
  const status = await fetch(new URL('/v1/runs/' + run, gateway), { headers: { authorization: 'Bearer ' + gatewayKey } });
  return status.ok ? (await status.json()).status : undefined;
}
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
const task = (title) => rpc('tools/call', { name: 'create_task', arguments: { title } });
async function mcp(config, body) {
  const response = await fetch(origin + new URL(config.url, origin).pathname, {
    method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

try {
  await startHq();
  cookie = await login('pause-owner@example.test');
  const stranger = await login('other-owner@example.test');
  const { bots: [a] } = await api('/bots');
  const { bot: b } = await api('/bots', 'POST', { name: 'Role B' });
  const { bot: c } = await api('/bots', 'POST', { name: 'Role C' });
  const bots = [a, b, c];
  const roles = await Promise.all(bots.map(async (bot, index) => {
    const hermesKey = 'isolated-role-key-' + index;
    const agent = await relay(hermesKey);
    const base = '/bots/' + bot.id;
    await api(base + '/agent', 'PUT', { hermesUrl: agent.url, hermesKey, websockifyUrl: '', cdpPort: null });
    const { hq: config } = await api(base + '/agent/mcp');
    return { ...agent, base, config };
  }));
  const [first, second, third] = roles;
  const [pause, resume] = [true, false].map((paused) => () => api(first.base + '/pause', 'PATCH', { paused }));
  const say = (role, text) => api(role.base + '/messages', 'POST', { text });
  const waitsForRow = (role, predicate, message) => until(async () => (await api(role.base + '/rows')).rows.find(({ body }) => predicate(body)), message);
  const waitsForRun = (role, i) => until(() => role.runs[i], 'Hermes did not admit the turn');
  const waitsForStatus = (id, status) => until(async () => await hermesStatus(id) === status, 'Hermes did not reach ' + status);
  const primary = { url: '/mcp/primary', headers: {
    authorization: 'Bearer ' + createHmac('sha256', secret).update('mcp:primary').digest('hex'),
  } };

  await api(first.base + '/pause', 'PATCH', { paused: 'true' }, 400);
  await api(first.base + '/pause', 'PATCH', { paused: true }, 401, '');
  await api(first.base + '/pause', 'PATCH', { paused: true }, 404, stranger);
  const routine = await mcp(first.config, rpc('tools/call', { name: 'create_routine', arguments: {
    name: 'Paused routine', prompt: 'HQ_TEST_STREAM', schedule: '0 0 31 12 *',
  } }));
  const { routine: { id: routineId } } = JSON.parse(routine.result.content[0].text);

  await writeFile(join(markerDir, 'hq-approval-marker'), 'test');
  await say(first, 'HQ_TEST_APPROVAL');
  const approvalRun = await waitsForRun(first, 0);
  const { body: card } = await waitsForRow(first, (body) => body.card === 'approval' && body.status === 'pending', 'No approval card');
  assert.deepEqual(await pause(), { paused: true });
  await waitsForStatus(approvalRun, 'cancelled');
  await waitsForRow(first, (body) => body.approvalId === card.approvalId && body.status === 'expired', 'Pause did not expire the approval');
  await api('/approvals/' + card.approvalId, 'POST', { decision: 'allow' });
  assert((await api(first.base + '/rows')).rows.some(({ body }) => body.approvalId === card.approvalId && body.status === 'expired'));
  assert(await exists('hq-approval-marker'));

  await stopHq();
  // Preserve the legacy primary alias of a migrated remote Agent.
  const db = new Database(join(data, 'hq.db'));
  db.prepare("UPDATE bots SET engine='primary' WHERE id=?").run(a.id);
  db.close();
  await startHq();
  const { bots: saved } = await api('/bots');
  assert.deepEqual(bots.map(({ id }) => saved.find((bot) => bot.id === id).paused), [true, false, false]);
  assert.match((await api(first.base + '/messages', 'POST', { text: 'Reject while paused' }, 409)).error, /paused/);
  assert.match((await api('/routines/' + routineId + '/run', 'POST', undefined, 409)).error, /paused/);
  const handoff = await mcp(second.config, rpc('tools/call', { name: 'send_to_bot', arguments: { bot_name: a.name, message: 'Try a handoff' } }));
  assert.match(handoff.result.content[0].text, /paused/);
  assert.match((await mcp(first.config, rpc('tools/list'))).error.message, /paused/);
  assert.equal((await mcp(first.config, rpc('ping'))).error, undefined);
  const [blocked, alias] = await Promise.all([mcp(first.config, task('Blocked')), mcp(primary, task('Blocked alias'))]);
  assert.equal(blocked.result.isError, true);
  assert.equal(alias.result.isError, true);
  assert.match(alias.result.content[0].text, /paused/);
  assert.equal((await api(first.base + '/tasks')).tasks.length, 0);
  assert.equal(first.runs.length, 1);

  await Promise.all([second, third].map(async (role) => {
    assert.equal((await mcp(role.config, task('Independent role'))).result.isError, undefined);
    assert.equal((await api(role.base + '/tasks')).tasks.length, 1);
    await say(role, 'HQ_TEST_STREAM');
    await waitsForStatus(await waitsForRun(role, 0), 'completed');
  }));

  assert.deepEqual(await resume(), { paused: false });
  for (const marker of ['hq-started', 'hq-finished']) await rm(join(markerDir, marker), { force: true });
  await say(first, 'HQ_TEST_STOP');
  const interrupted = await waitsForRun(first, 1);
  await until(() => exists('hq-started'), 'The terminal command did not start');
  await say(first, 'Queued before pause');
  await pause();
  await resume();
  await say(first, 'HQ_TEST_STREAM');
  await waitsForStatus(interrupted, 'cancelled');
  await waitsForStatus(await waitsForRun(first, 2), 'completed');
  await waitsForRow(first, (body) => body.role === 'assistant' && body.text === 'Hello from Hermes.' && !body.streaming, 'Resumed turn did not stream');
  await delay(8500);
  assert.equal(first.runs.length, 3, 'A turn queued before Pause was replayed');
  assert.equal(await exists('hq-finished'), false, 'The terminal command kept running after Pause');
  assert.equal((await mcp(primary, task('Resumed'))).result.isError, undefined);

  await rm(join(markerDir, 'hq-started'), { force: true });
  await say(second, 'HQ_TEST_STOP');
  const stopped = await waitsForRun(second, 1);
  await until(() => exists('hq-started'), 'The second role did not start');
  await say(second, 'HQ_TEST_STREAM');
  await api(second.base + '/interrupt', 'POST');
  await waitsForStatus(stopped, 'cancelled');
  await waitsForStatus(await waitsForRun(second, 2), 'completed');

  console.log('Pause persists across restart, isolates all three roles, blocks direct turns and MCP, expires approvals, cancels Hermes, and discards queued work across a rapid resume. Stop still runs queued work.');
  if (process.env.HQ_TEST_BROWSER === '1') {
    const { verifyPauseInBrowser } = await import('./pause-browser.mjs');
    await verifyPauseInBrowser(origin, cookie, bots);
  }
} finally {
  await stopHq();
  for (const server of relays) { server.closeAllConnections(); server.close(); }
  await rm(data, { recursive: true, force: true });
}
