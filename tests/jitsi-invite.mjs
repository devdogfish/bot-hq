import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';

Object.assign(process.env, {
  DB_PATH: ':memory:',
  SESSION_SECRET: 'jitsi-invite-test',
  HQ_LOCAL_ENGINES: '0',
  HQ_JITSI_ORIGINS: 'https://meet.example.test, https://gate.example.test:8443/',
});

const { db } = await import('../server/dist/db.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
const { jitsiInviteApi, jitsiInviteToken } = await import('../server/dist/jitsi-invite.js');
const { listRows } = await import('../server/dist/store.js');
initSubagents();
initRooms();

db.exec(`
  INSERT INTO users (id, email, name, created_at) VALUES ('owner', 'owner@example.test', 'Jo', 0), ('other', 'other@example.test', 'Al', 0);
  INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES ('browser', 'owner', 0, 9999999999999);
  INSERT INTO bots (id, user_id, name, label, kind, created_at, updated_at) VALUES
    ('tyler', 'owner', 'Tyler', 'Engineer', 'agent', 0, 0),
    ('stacy', 'owner', 'Stacy', '', 'agent', 1, 1),
    ('napping', 'owner', 'Nap', '', 'agent', 2, 2),
    ('team', 'owner', 'Team room', '', 'room', 3, 3),
    ('foreign', 'other', 'Tyson', '', 'agent', 4, 4);
  UPDATE bots SET paused=1 WHERE id='napping';
`);

const app = new Hono().route('/api/jitsi', jitsiInviteApi);
const origin = 'https://meet.example.test';
const auth = `Bearer ${jitsiInviteToken('owner')}`;
const people = (query, headers = { origin, authorization: auth }) =>
  app.request(`/api/jitsi/people?query=${encodeURIComponent(query)}&queryTypes=${encodeURIComponent('["user"]')}`, { headers });
const invite = (body, headers = { origin, authorization: auth }) =>
  app.request('/api/jitsi/invite', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const lastText = (botId) => listRows(botId, { limit: 10 }).filter((r) => r.kind === 'message').at(-1)?.body.text;

test('the signed-in Owner reads the token for the Jitsi origin', async () => {
  const res = await app.request('/api/jitsi/token', { headers: { cookie: 'grokbot_session=browser' } });
  assert.deepEqual(await res.json(), { token: jitsiInviteToken('owner'), origins: ['https://meet.example.test', 'https://gate.example.test:8443'] });
  assert.equal((await app.request('/api/jitsi/token')).status, 401);
});

test('search lists only the Owner\'s available Agents, with CORS for the Jitsi origin', async () => {
  const res = await people('ty');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await res.json(), [{ id: 'tyler', type: 'user', name: 'Tyler (Engineer)' }]);
  assert.deepEqual((await (await people('')).json()).map((p) => p.id), ['tyler', 'stacy']);
  assert.deepEqual(await (await people('engineer')).json(), [{ id: 'tyler', type: 'user', name: 'Tyler (Engineer)' }]);
});

test('preflight allows only configured origins', async () => {
  const ok = await app.request('/api/jitsi/invite', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), origin);
  const bad = await app.request('/api/jitsi/people', { method: 'OPTIONS', headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'GET' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal((await people('ty', { origin: 'https://evil.example.test', authorization: auth })).status, 403);
});

test('bad or missing tokens are refused', async () => {
  assert.equal((await people('ty', { origin })).status, 401);
  const forged = `Bearer owner.${'0'.repeat(64)}`;
  assert.equal((await people('ty', { origin, authorization: forged })).status, 401);
  const swapped = `Bearer other.${jitsiInviteToken('owner').split('.')[1]}`;
  assert.equal((await people('ty', { origin, authorization: swapped })).status, 401);
});

test('an invite posts the room link to each Agent as the Owner', async () => {
  const res = await invite({ url: 'https://meet.example.test/standup#config.startWithAudioMuted=true', invited: [{ id: 'tyler', type: 'user', name: 'Tyler' }, { id: 'stacy', type: 'user' }] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { invited: ['tyler', 'stacy'] });
  for (const id of ['tyler', 'stacy']) assert.equal(lastText(id), 'Join this meeting: https://meet.example.test/standup');
});

test('invites refuse other origins, unavailable Agents and other users\' Agents without sending any', async () => {
  const before = lastText('tyler');
  for (const url of ['https://evil.example.test/standup', 'http://meet.example.test/standup', 'https://u:p@meet.example.test/standup', 'https://meet.example.test/']) {
    assert.equal((await invite({ url, invited: [{ id: 'tyler', type: 'user' }] })).status, 400, url);
  }
  for (const id of ['napping', 'team', 'foreign']) {
    const res = await invite({ url: 'https://meet.example.test/x', invited: [{ id: 'tyler', type: 'user' }, { id, type: 'user' }] });
    assert.equal(res.status, 409, id);
  }
  assert.equal(lastText('tyler'), before);
  assert.equal(lastText('foreign'), undefined);
});
