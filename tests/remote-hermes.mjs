// Run against the isolated stock Hermes gateway and scripted model described in docs/remote-agents.md.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { access, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const hq = process.env.HQ_TEST_URL ?? 'http://127.0.0.1:18763';
const gateway = new URL(process.env.HQ_TEST_HERMES_URL ?? 'http://127.0.0.1:18762');
const markerDir = process.env.HQ_TEST_MARKER_DIR;
assert(markerDir, 'Use an isolated marker directory shared with the test model.');
const key = process.env.HQ_TEST_HERMES_KEY ?? 'hq-loopback-test';
const captured = [];
const proxy = createServer((incoming, outgoing) => {
  const upstream = request(new URL(incoming.url, gateway), {
    method: incoming.method,
    headers: { ...incoming.headers, host: gateway.host },
  }, (reply) => {
    outgoing.writeHead(reply.statusCode, reply.headers);
    if (incoming.method === 'POST' && incoming.url === '/v1/runs') {
      const body = [];
      reply.on('data', (chunk) => body.push(chunk));
      reply.on('end', () => {
        const data = JSON.parse(Buffer.concat(body));
        if (data.run_id) captured.push(data.run_id);
      });
    }
    reply.pipe(outgoing);
    outgoing.on('close', () => reply.destroy());
  });
  upstream.on('error', () => outgoing.destroy());
  incoming.pipe(upstream);
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');

const headers = { 'content-type': 'application/json', cookie: '' };
async function api(url, method = 'GET', body, expected = 200) {
  const res = await fetch(hq + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  assert.equal(res.status, expected, JSON.stringify(data));
  return data;
}
async function until(check, message) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  assert.fail(message);
}
const exists = (name) => access(path.join(markerDir, name)).then(() => true, () => false);
const remove = (name) => unlink(path.join(markerDir, name)).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});

try {
  const email = `remote-hq-${Date.now()}@example.test`;
  const login = await fetch(hq + '/api/auth/dev', {
    method: 'POST', headers, body: JSON.stringify({ email }),
  });
  assert.equal(login.status, 200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];

  const { bots: [bot] } = await api('/bots');
  const base = `/bots/${bot.id}`;
  const { bot: other } = await api('/bots', 'POST', { name: 'Other Agent' });
  const config = { hermesUrl: `http://127.0.0.1:${proxy.address().port}`, hermesKey: key,
    websockifyUrl: '', cdpPort: null };
  const { agent } = await api(base + '/agent', 'PUT', config);
  assert.equal(agent.hermesKeySet, true);
  assert.equal('hermesKey' in agent, false);
  assert.equal((await api(base + '/engine')).engine.status, 'ready');

  await api(`/bots/${other.id}/agent`, 'PUT', { ...config, hermesUrl: gateway.origin, hermesKey: 'wrong-key' });
  assert.match((await api(`/bots/${other.id}/engine`)).engine.error, /API key/);
  await api(base + '/agent', 'PUT', { ...config, hermesUrl: gateway.origin, hermesKey: '' }, 400);
  assert.equal((await api(base + '/agent')).agent.hermesUrl, config.hermesUrl);
  await api(base + '/agent', 'PUT', { ...config, hermesKey: '' });
  console.log('per-bot API keys isolated and write-only');

  async function rows() { return (await api(base + '/rows')).rows; }
  async function findRow(predicate, message) {
    return until(async () => (await rows()).find((row) => predicate(row.body)), message);
  }
  const assistant = (text, streaming) => (b) => b.type === 'message' && b.role === 'assistant' && b.text === text && !!b.streaming === streaming;

  await api(base + '/messages', 'POST', { text: 'HQ_TEST_STREAM' });
  await findRow(assistant('Hello ', true), 'expected a partial streamed row');
  await findRow(assistant('Hello from Hermes.', false), 'expected final reply');
  await api(base + '/messages', 'POST', { text: 'HQ_TEST_SAME' });
  await findRow(assistant('Same thread.', false), 'expected the declared Hermes conversation to persist');
  await api(base + '/fresh', 'POST');
  await api(base + '/messages', 'POST', { text: 'HQ_TEST_SAME' });
  await findRow(assistant('Fresh thread.', false), 'expected a new conversation after Fresh chat');
  console.log('incremental text, final text, continuity and Fresh chat passed');

  for (const decision of ['deny', 'allow']) {
    await writeFile(path.join(markerDir, 'hq-approval-marker'), 'test');
    await api(base + '/messages', 'POST', { text: 'HQ_TEST_APPROVAL' });
    const { body: card } = await findRow((b) => b.card === 'approval' && b.status === 'pending', 'expected Hermes approval card');
    assert.match(card.detail, /recursive delete/);
    assert(await exists('hq-approval-marker'), 'command ran before a decision');
    await api('/approvals/' + card.approvalId, 'POST', { decision: 'always' }, 400);
    await api('/approvals/' + card.approvalId, 'POST', { decision });
    await findRow((b) => b.card === 'approval' && b.approvalId === card.approvalId && b.status === (decision === 'allow' ? 'allowed' : 'denied'), 'card did not settle');
    const runId = captured.at(-1);
    await until(async () => {
      const res = await fetch(new URL('/v1/runs/' + runId, gateway), { headers: { authorization: `Bearer ${key}` } });
      return res.ok && (await res.json()).status === 'completed';
    }, 'Hermes turn did not finish');
    assert.equal(await exists('hq-approval-marker'), decision === 'deny');
  }
  console.log('smart escalation → card → deny leaves marker, allow once deletes marker');

  await remove('hq-started');
  await remove('hq-finished');
  await api(base + '/messages', 'POST', { text: 'HQ_TEST_STOP' });
  await until(() => exists('hq-started'), 'terminal command never started');
  const runId = captured.at(-1);
  const stoppedAt = Date.now();
  await api(base + '/interrupt', 'POST');
  await findRow((b) => b.type === 'notice' && b.text === 'Stopped.', 'expected confirmed stop in Bot HQ');
  const res = await fetch(new URL('/v1/runs/' + runId, gateway), { headers: { authorization: `Bearer ${key}` } });
  assert.equal((await res.json()).status, 'cancelled');
  const elapsedMs = Date.now() - stoppedAt;
  await delay(8500);
  assert.equal(await exists('hq-finished'), false, 'terminal command survived Stop');
  console.log(`Hermes confirmed cancelled after ${elapsedMs} ms and terminal completion marker never appeared`);

  const { hq: mcp } = await api(base + '/agent/mcp');
  async function callMcp(method, params) {
    const res = await fetch(hq + new URL(mcp.url).pathname, {
      method: 'POST', headers: { ...mcp.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).result;
  }
  const tools = (await callMcp('tools/list')).tools.map(({ name }) => name);
  assert(tools.includes('send_to_bot') && tools.includes('save_file'));
  assert(!tools.some((name) => /composio|event_trigger|app_connection/i.test(name)));
  await api('/apps', 'GET', undefined, 404);

  await callMcp('tools/call', { name: 'save_file', arguments: { filename: 'test.txt', content: 'MCP deliverable' } });
  const { url } = await api(base + '/files/download', 'POST', { path: 'test.txt' });
  assert.equal(await (await fetch(hq + url, { headers })).text(), 'MCP deliverable');
  console.log('Agent MCP authentication and Library delivery passed. Composio tools and routes are disabled.');

  const routine = await callMcp('tools/call', { name: 'create_routine', arguments: {
    name: 'Unattended approval test', prompt: 'HQ_TEST_APPROVAL', schedule: '0 0 31 12 *',
  } });
  const { routine: { id: routineId } } = JSON.parse(routine.content[0].text);
  await writeFile(path.join(markerDir, 'hq-approval-marker'), 'test');
  await api('/routines/' + routineId + '/run', 'POST');
  await findRow((b) => b.type === 'notice' && b.text.includes('unattended turn'), 'expected unattended refusal notice');
  assert(await exists('hq-approval-marker'));
  assert(!(await rows()).some(({ body }) => body.card === 'approval' && body.status === 'pending'));
  console.log('Unattended routine denied the escalation and left the marker intact.');
} finally {
  proxy.closeAllConnections();
  proxy.close();
}
