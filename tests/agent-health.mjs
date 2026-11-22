import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { agentHealthRoutes } from '../server/dist/agent-health.js';
import { readHermesHealth } from '../server/dist/hermes-health.js';

const targets = 'tyler=100.112.180.120,stacy=100.122.245.99';

test('configured Agent exposes only health status and uses one fixed upstream probe', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'ok', version: '0.23.1', platform: 'linux' }));
  const response = await agentHealthRoutes(targets).request('/tyler?url=http://127.0.0.1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'http://100.112.180.120:8642/health');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers, undefined);
});

test('unknown names and disabled monitoring do not make upstream requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok' }));
  for (const [setting, path] of [['', '/tyler'], [targets, '/sam'], [targets, '/Tyler']]) {
    const response = await agentHealthRoutes(setting).request(path);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('unhealthy, malformed, and unreachable gateways report 503', async (t) => {
  const outcomes = [
    () => Response.json({ status: 'error' }),
    () => new Response('not JSON'),
    () => new Response('unavailable', { status: 503 }),
    () => { throw new TypeError('connection failed'); },
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async () => outcomes.shift()());
  const app = agentHealthRoutes(targets);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await app.request('/stacy');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
  }
  assert.equal(fetch.mock.callCount(), 4);
});

test('cancels an oversized upstream health stream', async (t) => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const response = await agentHealthRoutes(targets).request('/tyler');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
  assert.equal(cancelled, true);
});

test('aborts a gateway stalled before headers or during its health body', { timeout: 5000 }, async (t) => {
  const seen = [];
  const endpoint = createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/body/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"status":');
    }
  });
  t.after(() => {
    endpoint.close();
    endpoint.closeAllConnections();
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const origin = `http://127.0.0.1:${endpoint.address().port}`;
  assert.deepEqual(await Promise.all([
    readHermesHealth(`${origin}/headers`, 500, 8192),
    readHermesHealth(`${origin}/body`, 500, 8192),
  ]), [null, null]);
  assert.deepEqual(seen.sort(), ['/body/health', '/headers/health']);
});

test('rejects non-tailnet addresses, URLs, extra fields and duplicate names', () => {
  for (const setting of [
    'tyler=127.0.0.1', 'tyler=100.63.0.1', 'tyler=100.128.0.1',
    'tyler=http://100.112.180.120', 'tyler=100.112.180.120:1200',
    'tyler=100.112.180.120=other', 'tyler=100.112.180.120,tyler=100.122.245.99',
  ]) {
    assert.throws(() => agentHealthRoutes(setting), /Invalid HQ_AGENT_HEALTH_TARGETS entry/);
  }
});

test('monitors shared gateways across restarts and connection changes with bounded fan-out', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-agent-health-'));
  const dbPath = join(dir, 'hq.db');
  const db = new Database(dbPath);
  let available = false;
  let onProbe;
  const probes = [];
  const endpoint = createServer((req, res) => {
    probes.push({ path: req.url, available });
    if (onProbe?.(req, res)) return;
    res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: available ? 'ok' : 'error' }));
  });
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }
  t.after(async () => {
    await stop();
    await new Promise((resolve) => {
      endpoint.close(resolve);
      endpoint.closeAllConnections();
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const gateway = `http://127.0.0.1:${endpoint.address().port}`;

  // Run the real server and advance only the monitor's timer, one completed probe cycle at a time.
  const preload = `
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (callback.name !== 'pollAgentGateways') return original(callback, ms, ...args);
      process.once('message', () => callback());
      process.send('checked');
      return { unref() {} };
    };
  `;
  const checked = async () => {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.equal(message, 'checked');
  };
  async function start() {
    child = fork(new URL('../server/dist/index.js', import.meta.url), [], {
      env: { ...process.env, DB_PATH: dbPath, HQ_DATA_DIR: dir, SESSION_SECRET: 'health-test',
        HQ_HOST: '127.0.0.1', PORT: '0', BOTHQ_NO_SCHEDULER: '0', HQ_LOCAL_ENGINES: '0',
        HQ_AGENT_HEALTH_TARGETS: '' },
      execArgv: ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await checked();
  }
  async function check() {
    const done = checked();
    child.send('check');
    await done;
  }

  await start();
  db.prepare('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,0)').run('owner', 'owner@example.test', 'Owner');
  db.prepare(`INSERT INTO bots (id,user_id,name,hermes_url,hermes_key,created_at,updated_at)
    VALUES (?,?,?,?,?,0,0)`).run('bot', 'owner', 'Tyler', gateway, 'test-key');
  const rows = () => db.prepare('SELECT kind,body FROM rows ORDER BY seq').all()
    .map(({ kind, body }) => ({ kind, ...JSON.parse(body) }));
  const unread = () => db.prepare('SELECT unread FROM bots WHERE id = ?').get('bot').unread;

  await check();
  await check();
  assert.deepEqual(rows(), []);
  assert.equal(unread(), 0);
  await stop();
  await start(); // The startup probe is failure three.
  assert.equal(probes.length, 3);
  const [down] = rows();
  assert.ok(down);
  const { text, ...body } = down;
  assert.deepEqual(body, { kind: 'event', type: 'event', event: 'gateway-health' });
  assert.match(text, /^Tyler's gateway stopped answering at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\.$/);
  assert.equal(unread(), 1);

  await stop();
  await start(); // The gateway is still down after restart.
  assert.equal(probes.length, 4);
  for (let attempt = 5; attempt <= 10; attempt++) await check();
  assert.deepEqual(probes, Array.from({ length: 10 }, () => ({ path: '/health', available: false })));
  assert.deepEqual(rows(), [down]);
  assert.equal(unread(), 1);

  available = true;
  await check();
  await check();
  await stop();
  await start();
  assert.equal(probes.length, 13);
  assert.deepEqual(rows(), [down, { kind: 'event', type: 'event', event: 'gateway-health', text: 'Tyler is back.' }]);
  assert.equal(unread(), 2);

  available = false;
  await check();
  available = true;
  await check();
  assert.deepEqual(db.prepare('SELECT * FROM agent_gateway_health').all(), []);

  // Emulate an outage persisted for the primary gateway before HERMES_URL changed on restart.
  const seed = db.prepare('INSERT INTO agent_gateway_health VALUES (?, ?, ?)');
  const healthRows = () => db.prepare('SELECT * FROM agent_gateway_health').all();
  seed.run('bot', `${gateway}/old`, 3);
  available = false;
  await check();
  assert.deepEqual(healthRows(), [{ bot_id: 'bot', gateway_url: gateway, consecutive_failures: 1 }]);
  available = true;
  await check();
  assert.equal(rows().length, 2);
  assert.deepEqual(db.prepare('SELECT * FROM agent_gateway_health').all(), []);

  const setGateway = db.prepare('UPDATE bots SET hermes_url = ? WHERE id = ?');
  seed.run('bot', gateway, 3);
  setGateway.run(`${gateway}/new`, 'bot');
  assert.deepEqual(db.prepare('SELECT * FROM agent_gateway_health').all(), []);
  setGateway.run(gateway, 'bot');
  available = false;
  onProbe = () => {
    setGateway.run(`${gateway}/new`, 'bot');
    setGateway.run(gateway, 'bot');
  };
  await check();
  assert.deepEqual(db.prepare('SELECT * FROM agent_gateway_health').all(), []);
  onProbe = undefined;

  const addBot = db.prepare(`INSERT INTO bots (id,user_id,name,hermes_url,hermes_key,kind,hidden,created_at,updated_at)
    VALUES (?,'owner',?,?,'test-key',?,?,0,0)`);
  addBot.run('shared', 'Shared', `${gateway}/`, 'agent', 0);
  addBot.run('hidden', 'Hidden', `${gateway}/hidden`, 'agent', 1);
  addBot.run('room', 'Room', `${gateway}/room`, 'room', 0);
  addBot.run('unconfigured', 'Unconfigured', null, 'agent', 0);
  for (let i = 1; i <= 9; i++) addBot.run(`extra-${i}`, `Extra ${i}`, `${gateway}/extra-${i}`, 'agent', 0);
  available = true;
  let peak = 0;
  const pending = [];
  let filledSlotsBeforeTimeout = false;
  const finish = (res) => res.end('{"status":"ok"}');
  onProbe = (req, res) => {
    if (pending.length === 8) {
      filledSlotsBeforeTimeout = !pending[0]?.destroyed;
      finish(res);
      finish(pending[0]);
      pending.push(res);
      return true;
    }
    pending.push(res);
    peak = Math.max(peak, pending.filter((response) => !response.writableEnded && !response.destroyed).length);
    if (pending.length === 8) for (const response of pending.slice(1)) finish(response);
    if (pending.length > 8) finish(res);
    return true;
  };
  probes.length = 0;
  await check();
  assert.equal(peak, 8);
  assert.equal(filledSlotsBeforeTimeout, true);
  assert.deepEqual(probes.map(({ path }) => path).sort(),
    ['/health', ...Array.from({ length: 9 }, (_, i) => `/extra-${i + 1}/health`)].sort());

  // An alert that cannot be appended must roll back without skipping the shared Bot.
  onProbe = undefined;
  available = false;
  seed.run('bot', gateway, 2);
  seed.run('shared', `${gateway}/`, 2);
  db.exec(`CREATE TRIGGER reject_alert BEFORE INSERT ON rows WHEN NEW.bot_id = 'bot'
    BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
  await check();
  const failureCount = (id) => db.prepare('SELECT consecutive_failures FROM agent_gateway_health WHERE bot_id = ?')
    .get(id).consecutive_failures;
  assert.equal(failureCount('bot'), 2);
  assert.equal(unread(), 2);
  assert.equal(failureCount('shared'), 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rows WHERE bot_id = 'shared'").get().n, 1);
  db.exec('DROP TRIGGER reject_alert');
  await check();
  assert.equal(failureCount('bot'), 3);
  assert.equal(unread(), 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rows WHERE bot_id = 'shared'").get().n, 1);
});
