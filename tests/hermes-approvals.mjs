import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

Object.assign(process.env, {
  SESSION_SECRET: 'test-only-hermes-approval-session',
  DB_PATH: ':memory:',
  DEV_LOGIN: '1',
  ALLOWED_EMAILS: '',
  HQ_LOCAL_ENGINES: '0',
});

const { api } = await import('../server/dist/routes.js');
const { db } = await import('../server/dist/db.js');
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

test('Hermes passes through approval choices, rejects unoffered choices, and resolves session siblings', async (t) => {
  const hq = new Hono();
  hq.route('/api', api);
  const decisions = [];
  const encoder = new TextEncoder();
  let stream;
  function emit(type, data = {}) {
    stream.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://127.0.0.1:29653');
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'tyler' }] });
    if (url.pathname === '/v1/runs' && options.method === 'POST') {
      return Response.json({ run_id: 'fixture-run' });
    }
    if (url.pathname === '/v1/runs/fixture-run/events') {
      return new Response(new ReadableStream({
        start(controller) { stream = controller; },
      }));
    }
    if (url.pathname === '/v1/runs/fixture-run/approval' && options.method === 'POST') {
      decisions.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    }
    if (url.pathname === '/v1/runs/fixture-run/stop') return Response.json({ ok: true });
    assert.fail('Unexpected gateway API path: ' + url.pathname);
  });

  const headers = { 'content-type': 'application/json' };
  const login = await hq.request('/api/auth/dev', {
    method: 'POST', headers, body: JSON.stringify({ email: 'tester@example.net' }),
  });
  assert.equal(login.status, 200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];

  async function request(path, method = 'GET', body, status = 200) {
    const response = await hq.request('/api' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reply = await response.json();
    assert.equal(response.status, status, JSON.stringify(reply));
    return reply;
  }

  const { bots: [bot] } = await request('/bots');
  const path = '/bots/' + bot.id;
  db.prepare('UPDATE bots SET hermes_url=?,hermes_key=? WHERE id=?')
    .run('http://127.0.0.1:29653', 'test-only-gateway-bearer', bot.id);
  await request(path + '/messages', 'POST', { text: 'Set up an approval fixture.' });
  await until(() => stream, 'Hermes event stream did not start');
  try {
    const choices = ['once', 'session', 'always', 'deny'];
    const prompt = (id, pattern, offered) => emit('approval.request', {
      prompt_id: id, execution_generation: 3, command: id, pattern_key: pattern, choices: offered,
    });
    prompt('first', 'shared', choices);
    prompt('sibling', 'shared', choices);
    prompt('limited', 'shared', ['once', 'deny']);
    prompt('separate', 'different', choices);
    const cards = async () => (await request(path + '/rows')).rows
      .map(({ body }) => body).filter((body) => body.card === 'approval');
    const [first, sibling, limited, separate] = await until(async () => {
      const rows = await cards();
      if (rows.length === 4) return rows;
    }, 'expected four approval cards');

    assert.deepEqual(first.choices, choices);
    assert.deepEqual(limited.choices, ['once', 'deny']);
    const decide = (card, decision, status) => request('/approvals/' + card.approvalId, 'POST', { decision }, status);
    await decide(limited, 'always', 409);
    assert.deepEqual(decisions, [], 'unoffered choice must not reach Hermes');
    assert.deepEqual((await cards()).map(({ status }) => status), ['pending', 'pending', 'pending', 'pending']);

    await decide(first, 'session');
    assert.deepEqual(decisions, [
      { request_id: 'first', execution_generation: 3, choice: 'session' },
      { request_id: 'sibling', execution_generation: 3, choice: 'session' },
    ]);
    assert.deepEqual((await cards()).map(({ status }) => status), ['session', 'session', 'pending', 'pending']);
    await decide(sibling, 'deny');
    assert.equal(decisions.length, 2, 'resolved sibling must not send a decision');

    await decide(limited, 'once');
    assert.deepEqual(decisions.at(-1), { request_id: 'limited', execution_generation: 3, choice: 'once' });
    await decide(separate, 'always');
    assert.deepEqual(decisions.at(-1), { request_id: 'separate', execution_generation: 3, choice: 'always' });
  } finally {
    emit('run.completed');
    stream.close();
    await until(() => !isBotBusy(bot.id), 'Bot HQ turn did not finish');
  }
});
