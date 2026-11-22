import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';

Object.assign(process.env, {
  SESSION_SECRET: 'test-only-message-actions',
  DB_PATH: ':memory:',
  DEV_LOGIN: '1',
  ALLOWED_EMAILS: '',
  HQ_LOCAL_ENGINES: '0',
});

const { api } = await import('../server/dist/routes.js');
const { db } = await import('../server/dist/db.js');
const { appendRow } = await import('../server/dist/store.js');
const { reactToMessage } = await import('../server/dist/agent/reactions.js');
const { initSubagents } = await import('../server/dist/agent/subagents.js');
const { initRooms } = await import('../server/dist/agent/rooms.js');
initSubagents();
initRooms();

test('the Owner reacts to Agent messages and forwards messages, keeping James apart', async () => {
  const hq = new Hono();
  hq.route('/api', api);
  const headers = { 'content-type': 'application/json' };
  const login = await hq.request('/api/auth/dev', { method: 'POST', headers, body: JSON.stringify({ email: 'owner@example.net' }) });
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path, method = 'GET', body) => {
    const res = await hq.request('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const { json: { bots: [trevor] } } = await request('/bots');
  const { json: { bot: sam } } = await request('/bots', 'POST', { name: 'Sam' });
  const { json: { bot: james } } = await request('/bots', 'POST', { name: 'James' });
  process.env.HQ_PERSONAL_BOT_ID = james.id;
  // Keep the Agents idle: no engine runs in this test.
  db.prepare('UPDATE bots SET paused=0').run();

  const owner = appendRow(trevor.id, 'message', { type: 'message', role: 'user', text: 'Ship it?' });
  const agent = appendRow(trevor.id, 'message', { type: 'message', role: 'assistant', text: 'Shipped. Notes are in the Library.' });

  // Reactions: only on an Agent's message; one per message; 'none' clears; unknown kinds are refused.
  let r = await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: 'heart' });
  assert.equal(r.status, 200);
  assert.equal(r.json.row.body.reaction.kind, 'heart');
  r = await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: 'thumbs_up' });
  assert.equal(r.json.row.body.reaction.kind, 'thumbs_up');
  assert.equal((await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: 'wink' })).status, 400);
  assert.equal((await request(`/bots/${trevor.id}/rows/${owner.seq}/reaction`, 'PATCH', { reaction: 'heart' })).status, 400);
  // Any single emoji works too; two emoji or plain text do not.
  r = await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: '🤩' });
  assert.equal(r.status, 200);
  assert.deepEqual({ kind: r.json.row.body.reaction.kind, emoji: r.json.row.body.reaction.emoji }, { kind: 'emoji', emoji: '🤩' });
  assert.equal((await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: '🤩🤩' })).status, 400);
  assert.equal((await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: 'ok' })).status, 400);
  r = await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: '👍🏽' });
  assert.equal(r.json.row.body.reaction.emoji, '👍🏽', 'a skin-tone emoji is one emoji');
  r = await request(`/bots/${trevor.id}/rows/${agent.seq}/reaction`, 'PATCH', { reaction: 'none' });
  assert.equal(r.json.row.body.reaction, undefined);

  // The Agent's tool takes a tapback or a single emoji on the Owner's latest message.
  assert.deepEqual(reactToMessage(trevor.id, '💓'), { ok: true, summary: 'Reacted 💓 to “Ship it?”' });
  assert.equal((await request(`/bots/${trevor.id}/rows`)).json.rows.find((x) => x.seq === owner.seq).body.reaction.emoji, '💓');
  assert.equal(reactToMessage(trevor.id, 'sparkles').ok, false);

  // Forwarding: lands in the other Agent's chat as the Owner's message, with where it came from.
  r = await request(`/bots/${trevor.id}/rows/${agent.seq}/forward`, 'POST', { toBotId: sam.id });
  assert.equal(r.status, 200);
  assert.equal(r.json.row.botId, sam.id);
  assert.equal(r.json.row.body.role, 'user');
  assert.match(r.json.row.body.text, /^Forwarded from .+:\n\nShipped\. Notes are in the Library\.$/);
  assert.equal((await request(`/bots/${trevor.id}/rows/${agent.seq}/forward`, 'POST', { toBotId: trevor.id })).status, 400);

  // James and the business Agents never exchange messages, in either direction (Quantself ADR 0060).
  assert.equal((await request(`/bots/${trevor.id}/rows/${agent.seq}/forward`, 'POST', { toBotId: james.id })).status, 403);
  const privateRow = appendRow(james.id, 'message', { type: 'message', role: 'assistant', text: 'Your dentist moved to 3pm.' });
  assert.equal((await request(`/bots/${james.id}/rows/${privateRow.seq}/forward`, 'POST', { toBotId: sam.id })).status, 403);
  const samRows = (await request(`/bots/${sam.id}/rows`)).json.rows;
  assert(!samRows.some(({ body }) => body.text?.includes('dentist')), 'a private message reached a business Agent');

  // The roster marks James so the app can leave him out of business forward targets.
  const roster = (await request('/bots')).json.bots;
  assert.equal(roster.find((b) => b.id === james.id).isPersonal, true);
  assert.equal(roster.find((b) => b.id === sam.id).isPersonal, false);
});
