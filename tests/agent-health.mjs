import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentHealthRoutes } from '../server/dist/agent-health.js';

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

test('rejects non-tailnet addresses, URLs, extra fields and duplicate names', () => {
  for (const setting of [
    'tyler=127.0.0.1', 'tyler=100.63.0.1', 'tyler=100.128.0.1',
    'tyler=http://100.112.180.120', 'tyler=100.112.180.120:1200',
    'tyler=100.112.180.120=other', 'tyler=100.112.180.120,tyler=100.122.245.99',
  ]) {
    assert.throws(() => agentHealthRoutes(setting), /Invalid HQ_AGENT_HEALTH_TARGETS entry/);
  }
});
