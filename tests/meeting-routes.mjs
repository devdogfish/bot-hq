// Offline, in process: node --import tsx --test tests/meeting-routes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

Object.assign(process.env, {
  DB_PATH: ':memory:',
  SESSION_SECRET: 'meeting-test',
  XAI_API_KEY: 'test-xai-key',
  HQ_MEETING_OWNER_NAMES: 'Jo Tester, , JO T. ',
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
        assert.equal(request.redirect, 'error');
        return Response.json({ value: 'ephemeral-test-secret', expires_at: Math.floor(Date.now() / 1000) + 300 });
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
const { appendRow, clearConversation, listRows } = await import('../server/src/store.ts');
const { isBotBusy } = await import('../server/src/agent/loop.ts');
const { closeInterruptedMeetings } = await import('../server/src/voice/index.ts');
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

let time = Date.now();
beforeEach((t) => {
  time += 60_001;
  t.mock.method(Date, 'now', () => time);
});

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

test('the Atlas Serve target restores the stripped meeting mount', async () => {
  const runbook = readFileSync(new URL('../docs/atlas-deploy.md', import.meta.url), 'utf8');
  const serve = runbook.match(/^sudo tailscale serve --bg --https=8787 --set-path=(\/api\/meeting) (http:\/\/\S+)$/m);
  assert.ok(serve, 'Expected a meeting mount on the Agent listener');
  const [, mount, target] = serve;
  for (const route of ['session', 'gate', 'tool', 'end']) {
    const stripped = `${mount}/${route}`.slice(mount.length);
    const upstream = `${new URL(target).pathname}${stripped}`;
    assert.equal((await post(upstream, {})).status, 401);
    assert.equal((await post(upstream, {}, bearer('stacy'))).status, 400);
    assert.equal((await post(stripped, {}, bearer('stacy'))).status, 404);
  }
});

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

test('gate applies direct address, follow-ups and bare cues from configured Owner display names', async () => {
  const { call_id } = await meetingPost('session', meeting);
  const ask = (speaker, text, lastTurnAt) => meetingPost('gate', gate(call_id, [say(speaker, text)], lastTurnAt));
  const before = requests.length;
  assert.deepEqual(await ask('Priya', 'Anyone have updates?'), { decision: 'silent' });
  assert.deepEqual(await ask('Priya', 'Stacy, what is the status?'), { decision: 'respond' });
  assert.deepEqual(await ask('Priya', 'Which update?', 1000), { decision: 'respond' });
  assert.deepEqual(await ask('Owner', 'Mute yourself.'), { decision: 'silent' });
  assert.deepEqual(await ask('Jo Tester Jr.', 'Mute yourself.'), { decision: 'silent' });
  assert.deepEqual(await ask('jO tEsTeR', 'Mute yourself.'), { decision: 'silent', action: 'mute' });
  assert.deepEqual(await ask('Priya', 'Unmute.'), { decision: 'silent' });
  assert.deepEqual(await ask('Jo T.', 'Unmute.'), { decision: 'silent', action: 'unmute' });
  assert.deepEqual(await ask('Priya', 'Stacy, mute yourself.'), { decision: 'silent', action: 'mute' });
  assert.deepEqual(await ask('Priya', 'Stacy, go ahead.'), { decision: 'silent' });
  assert.deepEqual(await ask('Priya', 'Stacy, unmute.'), { decision: 'silent', action: 'unmute' });
  assert.deepEqual(await ask('Priya', 'What is the status?'), { decision: 'silent' });
  assert.equal(requests.length, before);
  await meetingPost('end', { call_id, transcript: [] });
});

test('gate and end bound transcript payloads and rate limits apply across bearer aliases', async () => {
  const { call_id } = await meetingPost('session', meeting);
  await meetingPost('gate', gate(call_id, Array(25).fill(say('Priya', 'Hello'))), bearer('stacy'), 400);
  await meetingPost('gate', gate(call_id, [say('Priya', 'a'.repeat(512 * 1024))]), bearer('stacy'), 413);
  await meetingPost('end', { call_id, transcript: [say('Priya', 'a'.repeat(2 * 1024 * 1024))] }, bearer('stacy'), 413);
  for (let count = 2; count < 120; count++) await meetingPost('gate', gate(call_id, []));
  const response = await post('/api/meeting/gate', gate(call_id, []), bearer('primary'));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
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

  // A guest, even one named like the Owner, cannot hand the Agent work.
  await meetingPost('gate', gate(call_id, [say('Owner', 'Stacy, check the rollout.')]));
  const refused = await meetingPost('tool', tool);
  assert.match(refused.output, /only the meeting host/);
  await meetingPost('gate', gate(call_id, [{ ...say('Priya', 'Stacy, check the rollout.'), host: false }]));
  assert.match((await meetingPost('tool', tool)).output, /only the meeting host/);
  assert.ok(!listRows('stacy').some(({ body }) => body.text === tool.arguments.request));

  await meetingPost('gate', gate(call_id, [{ ...say('Host', 'Stacy, check the rollout.'), host: true }]));
  const start = requests.length;
  const handedOff = await meetingPost('tool', { ...tool, bot_id: 'alex' });
  assert.match(handedOff.output, /Handed off/);
  // Meeting requests run straight away, like chat requests; no approval card.
  await waitFor(() => requests.slice(start).some(({ url }) => url === 'https://hermes.meeting.test/v1/responses'));
  await waitFor(() => !isBotBusy('stacy'));
  assert.ok(!listRows('stacy').some(({ body }) => body.card === 'approval'));
  const row = listRows('stacy').find((row) => row.seq === handedOff.taskSeq);
  assert.equal(row.body.text, tool.arguments.request);
  assert.equal(row.body.from.id, call_id);
  const runs = requests.slice(start).filter(({ url }) => url === 'https://hermes.meeting.test/v1/responses');
  assert.equal(runs.length, 1);
  assert.match(runs[0].payload.input, /\[Meeting: Asked for in a live meeting with the Owner\..*\]\nCheck the rollout\./);
  assert.match(runs[0].payload.conversation, /^hq-stacy-/);
  assert.ok(!listRows('alex').some((row) => row.body.text === tool.arguments.request));
  await meetingPost('end', { call_id, transcript: [] });
});

test('session rejects the long-lived API key even if returned by the mint endpoint', async (t) => {
  t.mock.method(http, 'fetch', () => Response.json({ value: 'test-xai-key', expires_at: Math.floor(Date.now() / 1000) + 300 }));
  const result = await meetingPost('session', meeting, bearer('stacy'), 502);
  assert.doesNotMatch(JSON.stringify(result), /test-xai-key/);
});

test('ongoing meetings survive two hours and abandoned rows close in place', async () => {
  const { call_id } = await meetingPost('session', meeting);
  const row = () => listRows('stacy').find(({ body }) => body.call?.id === call_id);
  const seq = row().seq;
  time += 90 * 60_000;
  await meetingPost('gate', gate(call_id, []));
  time += 90 * 60_000;
  await meetingPost('gate', gate(call_id, []));
  time += 120 * 60_000;
  await meetingPost('gate', gate(call_id, []), bearer('stacy'), 404);
  assert.equal(row().seq, seq);
  assert.equal(row().body.call.phase, 'ended');
  assert.equal(row().body.text, 'Meeting timed out');
  const transcript = [say('Priya', 'Late but delivered.')];
  assert.equal((await meetingPost('end', { call_id, transcript })).seq, seq);
  assert.equal(row().body.call.transcript[0].text, transcript[0].text);

  const interrupted = await meetingPost('session', meeting);
  closeInterruptedMeetings();
  const recovered = listRows('stacy').find(({ body }) => body.call?.id === interrupted.call_id);
  assert.equal(recovered.body.call.phase, 'ended');
  assert.match(recovered.body.text, /restarted/);
});

test('a delayed summary stays on the original conversation generation', { timeout: 5000 }, async (t) => {
  const { call_id } = await meetingPost('session', meeting, bearer('alex'));
  const entered = Promise.withResolvers();
  const result = Promise.withResolvers();
  t.mock.method(http, 'fetch', () => { entered.resolve(); return result.promise; });
  const { seq } = await meetingPost('end', { call_id, transcript: [say('Priya', 'Deferred summary.')] }, bearer('alex'));
  const { generation } = listRows('alex').find((row) => row.seq === seq);
  await entered.promise;
  clearConversation('alex');
  for (let i = 1; i <= seq; i++) appendRow('alex', 'message', { type: 'message', role: 'user', text: `New message ${i}` });
  result.resolve(Response.json({ object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Old meeting summary.' }] }] }));
  const oldRow = () => db.prepare("SELECT body FROM rows WHERE bot_id='alex' AND generation=? AND seq=?").get(generation, seq);
  await waitFor(() => oldRow()?.body.includes('Old meeting summary.'));
  assert.equal(listRows('alex').find((row) => row.seq === seq).body.text, `New message ${seq}`);
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
  assert.equal((await meetingPost('end', { call_id, transcript })).seq, ended.seq);
  await meetingPost('end', { call_id, transcript }, bearer('alex'), 404);
  await meetingPost('gate', gate(call_id, transcript), bearer('stacy'), 404);
  assert.equal(listRows('stacy').filter(({ body }) => body.call?.id === call_id && body.call.phase === 'ended').length, 1);
});

test('gate treats an Agent first name as addressing a full-named Agent', async () => {
  db.exec("UPDATE bots SET name = 'Stacy Ross' WHERE id = 'stacy'");
  try {
    const { call_id } = await meetingPost('session', meeting);
    const ask = (speaker, text) => meetingPost('gate', gate(call_id, [say(speaker, text)]));
    assert.deepEqual(await ask('Priya', 'Stacy, can you give your update?'), { decision: 'respond' });
    assert.deepEqual(await ask('Priya', 'Stacy, mute yourself please.'), { decision: 'silent', action: 'mute' });
    assert.deepEqual(await ask('Priya', 'Ross is out today.'), { decision: 'silent' });
    await meetingPost('end', { call_id, transcript: [] });
  } finally {
    db.exec("UPDATE bots SET name = 'Stacy' WHERE id = 'stacy'");
  }
});
