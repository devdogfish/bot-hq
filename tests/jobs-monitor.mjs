import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'synthetic-jobs-monitor-fixture';
process.env.DB_PATH = ':memory:';
process.env.HQ_JOBS_MONITOR_BOT_ID = 'bot_fixture_sam';

const { db } = await import('../server/src/db.ts');
const { mcpToken } = await import('../server/src/engine.ts');
const { mcpApi } = await import('../server/src/mcp.ts');
const { checkJobsMonitorHealth } = await import('../server/src/jobs-monitor.ts');
const sam = process.env.HQ_JOBS_MONITOR_BOT_ID;
const other = 'bot_fixture_other';
db.prepare('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'fixture@example.invalid', 'Owner', 0);
const addBot = db.prepare('INSERT INTO bots (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)');
addBot.run(sam, 'owner', 'Sam', 0, 0);
addBot.run(other, 'owner', 'Other', 0, 0);
db.prepare('INSERT INTO routines (id,bot_id,name,prompt,schedule,created_at) VALUES (?,?,?,?,?,?)')
  .run('rt_fixture', sam, 'Jobs inbox monitoring', 'check', '*/5 * * * *', 0);

async function call(bot, args) {
  const response = await mcpApi.request(`/${bot}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(bot)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jobs_monitor_checkpoint', arguments: args } }),
  });
  assert.equal(response.status, 200);
  return JSON.parse((await response.json()).result.content[0].text);
}

const checkpoint = { uidvalidity: null, after_uid: 0 };
assert.deepEqual(await call(sam, { kind: 'read' }), { status: 'ok', checkpoint });
assert.deepEqual(await call(other, { kind: 'read' }), { status: 'disabled' });
const page = { kind: 'page', checkpoint, uidvalidity: 345, after_uid: 42, uids: [17, 42] };
assert.deepEqual(await call(sam, page), { status: 'ok' });
assert.deepEqual(await call(sam, page), { status: 'conflict' });
assert.deepEqual(await call(sam, { kind: 'read' }), { status: 'ok', checkpoint: { uidvalidity: 345, after_uid: 42 } });

function alerts() {
  return db.prepare('SELECT body FROM rows WHERE bot_id=? ORDER BY seq').all(sam)
    .map(({ body }) => JSON.parse(body).text);
}
assert.equal(alerts().length, 1);
assert.match(alerts()[0], /2 new Jobs inbox messages.*17, 42/);

const saved = { uidvalidity: 345, after_uid: 42 };
assert.deepEqual(await call(sam, { kind: 'page', checkpoint: saved, uidvalidity: 345, after_uid: 45, uids: [46] }), { status: 'invalid' });
checkJobsMonitorHealth(sam, Date.now() + 13 * 60_000);
checkJobsMonitorHealth(sam, Date.now() + 14 * 60_000);
assert.equal(alerts().length, 2);
assert.match(alerts()[1], /has not confirmed a check/);

assert.deepEqual(await call(sam, { kind: 'read' }), { status: 'ok', checkpoint: saved });
assert.deepEqual(await call(sam, { kind: 'page', checkpoint: saved, uidvalidity: 345, after_uid: 45, uids: [43, 45] }), { status: 'ok' });
assert.match(alerts()[2], /2 new Jobs inbox messages.*43, 45/);
const failure = { kind: 'failed', checkpoint: { uidvalidity: 345, after_uid: 45 }, reason: 'unavailable' };
await call(sam, failure);
await call(sam, failure);
assert.equal(alerts().length, 4);
assert.match(alerts()[3], /could not confirm a check/);
assert.deepEqual(await call(sam, { kind: 'read' }), { status: 'ok', checkpoint: failure.checkpoint });
console.log('Jobs monitor: cursor recovery, deduplication, outage alerts and cross-agent isolation passed.');
