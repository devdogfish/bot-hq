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
  const rejected = new Set();
  const alreadyResolved = new Set();
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
      const decision = JSON.parse(options.body);
      decisions.push(decision);
      if (rejected.has(decision.request_id)) return Response.json({ ok: false }, { status: 409 });
      const status = alreadyResolved.has(decision.request_id) ? 'already_resolved' : 'resolved';
      return Response.json({ status, prompt_id: decision.request_id });
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
    const prompt = (id, pattern, offered, keys) => emit('approval.request', {
      prompt_id: id, execution_generation: 3, command: id,
      pattern_key: pattern, pattern_keys: keys, choices: offered,
    });
    prompt('first', 'shared', choices);
    prompt('sibling', 'shared', choices);
    prompt('limited', 'shared', ['once', 'deny']);
    prompt('separate', 'different', choices);
    prompt('extra-rule', 'shared', choices, ['shared', 'independent-rule']);
    prompt('always-sibling', 'different', choices, ['different']);
    const cards = async () => (await request(path + '/rows')).rows
      .map(({ body }) => body).filter((body) => body.card === 'approval');
    const [first, sibling, limited, separate, extraRule, alwaysSibling] = await until(async () => {
      const rows = await cards();
      if (rows.length === 6) return rows;
    }, 'expected six approval cards');

    assert.deepEqual(first.choices, choices);
    assert.deepEqual(limited.choices, ['once', 'deny']);
    const decide = (card, decision, status) => request('/approvals/' + card.approvalId, 'POST', { decision }, status);
    await decide(limited, 'always', 409);
    assert.deepEqual(decisions, [], 'unoffered choice must not reach Hermes');
    assert.ok((await cards()).every(({ status }) => status === 'pending'));

    await decide(first, 'session');
    assert.deepEqual(decisions, [
      { request_id: 'first', execution_generation: 3, choice: 'session' },
      { request_id: 'sibling', execution_generation: 3, choice: 'session' },
    ]);
    assert.deepEqual((await cards()).map(({ status }) => status), ['session', 'session', 'pending', 'pending', 'pending', 'pending']);
    await decide(sibling, 'deny');
    assert.equal(decisions.length, 2, 'resolved sibling must not send a decision');

    await decide(limited, 'once');
    assert.deepEqual(decisions.at(-1), { request_id: 'limited', execution_generation: 3, choice: 'once' });
    await decide(extraRule, 'deny');
    assert.deepEqual(decisions.at(-1), { request_id: 'extra-rule', execution_generation: 3, choice: 'deny' });

    rejected.add('always-sibling');
    const partial = await decide(separate, 'always', 409);
    assert.equal(partial.error, 'Could not resolve every related approval.');
    assert.deepEqual(decisions.slice(-2), [
      { request_id: 'separate', execution_generation: 3, choice: 'always' },
      { request_id: 'always-sibling', execution_generation: 3, choice: 'always' },
    ]);
    assert.deepEqual((await cards()).slice(-3).map(({ status }) => status), ['always', 'denied', 'pending']);
    rejected.delete('always-sibling');
    await decide(alwaysSibling, 'always');
    assert.equal((await cards()).at(-1).status, 'always');

    prompt('stale', 'same', choices);
    prompt('still-pending', 'same', choices);
    const [stale] = await until(async () => {
      const rows = await cards();
      if (rows.length === 8) return rows.slice(-2);
    }, 'expected two additional approval cards');
    alreadyResolved.add('stale');
    const count = decisions.length;
    await decide(stale, 'session', 409);
    assert.equal(decisions.length, count + 1, 'unconfirmed primary must not resolve another prompt');
    assert.equal((await cards()).at(-1).status, 'pending');

    const authorityChoices = ['once', 'deny', 'session', 'always'];
    for (const id of ['authority', 'unkeyed-sibling']) {
      emit('approval.request', {
        kind: 'approval', prompt_id: id, execution_generation: 3,
        command: 'same command', description: 'same rule', choices: authorityChoices,
      });
    }
    const [authority, unkeyedSibling] = await until(async () => {
      const rows = await cards();
      if (rows.length === 10) return rows.slice(-2);
    }, 'expected two approvals from the session authority');
    assert.deepEqual(authority.choices, authorityChoices);
    await decide(authority, 'session');
    assert.deepEqual(decisions.slice(count + 1), [
      { request_id: 'authority', execution_generation: 3, choice: 'session' },
    ]);
    assert.deepEqual((await cards()).slice(-2).map(({ status }) => status), ['session', 'pending']);
    await decide(unkeyedSibling, 'always');
    assert.deepEqual(decisions.at(-1), { request_id: 'unkeyed-sibling', execution_generation: 3, choice: 'always' });
  } finally {
    emit('run.completed');
    stream.close();
    await until(() => !isBotBusy(bot.id), 'Bot HQ turn did not finish');
  }
});
