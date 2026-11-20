// Offline, in process: node --import tsx --test tests/meeting-routes.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

Object.assign(process.env, {
  DB_PATH: ':memory:',
  SESSION_SECRET: 'meeting-test',
  XAI_API_KEY: 'test-xai-key',
  HQ_LOCAL_ENGINES: '1',
  HERMES_HOME_PRIMARY: '/nonexistent/meeting-test-home',
  HERMES_URL: 'https://hermes.meeting.test',
  HERMES_KEY: 'test-hermes-key',
});

const requests = [];
const realFetch = globalThis.fetch;
const http = {
  async fetch(request, payload) {
    switch (new URL(request.url).pathname) {
      case '/v1/realtime/client_secrets':
        assert.equal(request.headers.get('Authorization'), 'Bearer test-xai-key');
        assert.deepEqual(payload, { expires_after: { seconds: 300 } });
        return Response.json({ value: 'ephemeral-test-secret', expires_at: 12345 });
      case '/v1/chat/completions':
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'respond' } }] });
      case '/v1/responses':
        if (new URL(request.url).hostname === 'hermes.meeting.test') {
          return new Response('event: run.completed\ndata: {"output":"Rollout checked."}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return Response.json({ object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Discussed the rollout.' }] }] });
      default:
        assert.fail(`Unexpected request ${request.url}`);
    }
  },
};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const payload = request.body ? await request.json() : null;
  requests.push({ url: request.url, payload });
  return http.fetch(request, payload);
};
after(() => { globalThis.fetch = realFetch; });

const { db } = await import('../server/src/db.ts');
const { mcpToken } = await import('../server/src/engine.ts');
const { listRows } = await import('../server/src/store.ts');
const { isBotBusy } = await import('../server/src/agent/loop.ts');
const { initRooms } = await import('../server/src/agent/rooms.ts');
const { initSubagents } = await import('../server/src/agent/subagents.ts');
const { meetingApi } = await import('../server/src/meeting/routes.ts');
const { mcpApi } = await import('../server/src/mcp.ts');
const { api } = await import('../server/src/routes.ts');

initRooms();
initSubagents();
db.exec(`
  INSERT INTO users (id, email, name, created_at) VALUES ('owner', 'owner@example.test', 'Jo Tester', 0);
  INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES ('browser', 'owner', 0, 9999999999999);
  INSERT INTO bots (id, user_id, name, instructions, voice, voice_provider, created_at, updated_at, engine)
  VALUES ('stacy', 'owner', 'Stacy', 'Private Stacy instructions', 'eve', 'xai', 0, 0, 'primary'),
         ('alex', 'owner', 'Alex', 'Private Alex instructions', 'eleven-id', 'elevenlabs', 0, 0, NULL);
`);

const app = new Hono().route('/mcp', mcpApi).route('/api/meeting', meetingApi).route('/api', api);
const bearer = (botId) => `Bearer ${mcpToken(botId)}`;
const cookie = 'grokbot_session=browser';
const meeting = { url: 'https://meet.example.test/standup?token=invite', platform: 'jitsi' };
const say = (speaker, text, at = 2000) => ({ speaker, text, at });
const gate = (call_id, transcript, last_agent_turn_at = null) => ({ call_id, transcript, last_agent_turn_at });

function post(path, body, authorization, cookieHeader) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { authorization } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function meetingPost(route, data, authorization = bearer('stacy'), status = 200) {
  const response = await post(`/api/meeting/${route}`, data, authorization);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

async function waitFor(condition) {
  for (let tries = 0; tries < 200 && !condition(); tries++) await delay(10);
  assert.ok(condition(), 'Expected the background work to finish');
}

test('meeting auth accepts the existing MCP bearer and binds the session to its bot', async () => {
  const before = requests.length;
  for (const route of ['session', 'gate', 'tool', 'end']) {
    assert.equal((await post(`/api/meeting/${route}`, meeting, undefined, cookie)).status, 401);
    await meetingPost(route, meeting, bearer('nonexistent'), 401);
    await meetingPost(route, meeting, mcpToken('stacy'), 401);
  }
  await meetingPost('session', { ...meeting, url: 'file:///standup' }, bearer('stacy'), 400);
  assert.equal(requests.length, before);

  const mcp = await post('/mcp/stacy', { jsonrpc: '2.0', id: 1, method: 'ping' }, bearer('stacy'));
  assert.equal(mcp.status, 200);
  const response = await post('/api/meeting/session', { ...meeting, bot_id: 'alex' }, bearer('stacy'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const session = await response.json();
  assert.deepEqual(Object.keys(session).sort(),
    ['call_id', 'client_secret', 'instructions', 'model', 'provider', 'sample_rate', 'tools', 'voice', 'ws_url']);
  assert.equal(session.provider, 'xai');
  assert.equal(session.client_secret, 'ephemeral-test-secret');
  assert.equal(session.sample_rate, 24000);
  assert.equal(session.voice, 'eve');
  assert.equal(new URL(session.ws_url).searchParams.get('model'), session.model);
  assert.match(session.instructions, /Stacy.*meeting/);
  assert.match(session.instructions, /only when the turn gate.*floor/);
  assert.doesNotMatch(JSON.stringify(session), /Private Stacy|Jo Tester|test-xai-key|invite/);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['send_task']);
  assert.ok(listRows('stacy').some((row) => row.body.call?.id === session.call_id && row.body.call.phase === 'started'));
  assert.ok(!listRows('alex').some((row) => row.body.call?.id === session.call_id));
  await meetingPost('end', { call_id: session.call_id, transcript: [] });

  const alex = await meetingPost('session', { ...meeting, platform: 'google_meet' }, bearer('alex'));
  assert.equal(alex.voice, 'luna');
  assert.match(alex.instructions, /Alex/);
  await meetingPost('end', { call_id: alex.call_id, transcript: [] }, bearer('alex'));
});

test('primary MCP token loses access to the previous bot after reassignment', async (t) => {
  t.after(() => db.exec("UPDATE bots SET engine = 'primary' WHERE id = 'stacy'; UPDATE bots SET engine = NULL WHERE id = 'alex'"));
  const primary = bearer('primary');
  const { call_id } = await meetingPost('session', meeting, primary);
  db.exec("UPDATE bots SET engine = NULL WHERE id = 'stacy'; UPDATE bots SET engine = 'primary' WHERE id = 'alex'");
  await meetingPost('gate', gate(call_id, []), primary, 404);
  await meetingPost('end', { call_id, transcript: [] });
});

test('gate applies direct address, follow-ups, mute state and the ambiguous-turn classifier', async () => {
  const { call_id } = await meetingPost('session', meeting);
  const ask = (speaker, text, lastTurnAt) => meetingPost('gate', gate(call_id, [say(speaker, text)], lastTurnAt));
  const before = requests.length;
  assert.deepEqual(await ask('Priya', 'Anyone have updates?'), { decision: 'silent' });
  assert.deepEqual(await ask('Priya', 'Stacy, what is the status?'), { decision: 'respond' });
  assert.deepEqual(await ask('Priya', 'Which update?', 1000), { decision: 'respond' });
  assert.deepEqual(await ask('Owner', 'Mute yourself.'), { decision: 'silent', action: 'mute' });
  assert.deepEqual(await ask('Priya', 'Stacy, go ahead.'), { decision: 'silent' });
  assert.deepEqual(await ask('Owner', 'Unmute.'), { decision: 'silent', action: 'unmute' });
  assert.equal(requests.length, before);
  assert.deepEqual(await ask('Priya', 'What is the status?'), { decision: 'respond' });
  const model = requests.at(-1);
  assert.match(model.url, /chat\/completions$/);
  assert.match(model.payload.messages[1].content, /Stacy.*Priya.*What is the status/);
  await meetingPost('end', { call_id, transcript: [] });
});

test('a pending classifier cannot give the floor after a mute command', { timeout: 5000 }, async (t) => {
  const { call_id } = await meetingPost('session', meeting);
  const entered = Promise.withResolvers();
  const result = Promise.withResolvers();
  t.mock.method(http, 'fetch', () => { entered.resolve(); return result.promise; });
  const pending = meetingPost('gate', gate(call_id, [say('Priya', 'Can you check this?')]));
  await entered.promise;
  assert.deepEqual(await meetingPost('gate', gate(call_id, [say('Owner', 'Mute yourself.', 3000)])), {
    decision: 'silent', action: 'mute',
  });
  result.resolve(Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'respond' } }] }));
  assert.deepEqual(await pending, { decision: 'silent' });
  await meetingPost('end', { call_id, transcript: [] });
});

test('tool relay queues work only for the bound bot and rejects cross-mode call IDs', { timeout: 5000 }, async () => {
  const { call_id } = await meetingPost('session', meeting);
  const tool = { call_id, name: 'send_task', arguments: { request: 'Check the rollout.' } };
  await meetingPost('tool', tool, bearer('alex'), 404);
  await meetingPost('gate', gate(call_id, []), bearer('alex'), 404);
  await meetingPost('end', { call_id, transcript: [] }, bearer('alex'), 404);
  await meetingPost('tool', { ...tool, name: 'search_conversations', arguments: { scope: 'everything' } }, bearer('stacy'), 403);
  const voiceTool = await post('/api/voice/tool', { botId: 'stacy', callId: call_id, name: 'send_task', args: tool.arguments }, undefined, cookie);
  assert.equal(voiceTool.status, 404);
  const voiceSession = await post('/api/voice/session', { botId: 'stacy' }, undefined, cookie);
  assert.equal(voiceSession.status, 200);
  const { callId } = await voiceSession.json();
  await meetingPost('tool', { ...tool, call_id: callId }, bearer('stacy'), 404);

  const start = requests.length;
  const handedOff = await meetingPost('tool', { ...tool, bot_id: 'alex' });
  assert.match(handedOff.output, /Handed off/);
  await waitFor(() => !isBotBusy('stacy'));
  const row = listRows('stacy').find((row) => row.seq === handedOff.taskSeq);
  assert.equal(row.body.text, tool.arguments.request);
  assert.equal(row.body.from.id, call_id);
  const runs = requests.slice(start).filter(({ url }) => url === 'https://hermes.meeting.test/v1/responses');
  assert.equal(runs.length, 1);
  assert.match(runs[0].payload.input, /\[Meeting: A participant.*\]\nCheck the rollout\./);
  assert.match(runs[0].payload.conversation, /^hq-stacy-/);
  assert.ok(!listRows('alex').some((row) => row.body.text === tool.arguments.request));
  await meetingPost('end', { call_id, transcript: [] });
});

test('end stores attributed transcript and updates the chat with a summary', { timeout: 5000 }, async () => {
  const { call_id } = await meetingPost('session', { ...meeting, platform: 'zoom' });
  const transcript = [say('Priya', 'We shipped the rollout.', 1234), say('Stacy', 'I will check the logs.', 2000)];
  const ended = await meetingPost('end', { call_id, transcript });
  const row = () => listRows('stacy').find(({ seq }) => seq === ended.seq);
  assert.deepEqual(row().body.call.transcript, [
    { ...transcript[0], role: 'user' },
    { ...transcript[1], role: 'assistant' },
  ]);
  assert.match(row().body.text, /Meeting ended/);
  await waitFor(() => row().body.call.summary === 'Discussed the rollout.');
  assert.match(row().body.text, /Discussed the rollout/);
  const model = requests.find(({ payload }) => payload?.input?.[1]?.content?.includes('We shipped the rollout.'));
  assert.match(model.payload.input[1].content, /Priya: We shipped the rollout\.\nStacy: I will check the logs\./);
  await meetingPost('end', { call_id, transcript }, bearer('stacy'), 404);
  await meetingPost('gate', gate(call_id, transcript), bearer('stacy'), 404);
  assert.equal(listRows('stacy').filter(({ body }) => body.call?.id === call_id && body.call.phase === 'ended').length, 1);
});
