// Build the server, then run with node tests/draft-only.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'hq-draft-only-'));
const admissions = { ordinary: [], draft: [] };
const stops = [];
let draftAvailable = true;
let slowDraftStarted = false;
let hq;
let origin;
let cookie;

async function gateway(role) {
  const key = `fixture-${role}-key`;
  const runs = new Map();
  const waiting = new Map();
  const server = createServer(async (req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
    if (req.method === 'POST' && req.url === '/v1/runs') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      const runId = String(runs.size + 1);
      runs.set(runId, payload);
      admissions[role].push({ payload, session: req.headers['x-hermes-session-key'] });
      if (role === 'draft' && !draftAvailable) return res.writeHead(503).end();
      return res.end(JSON.stringify({ run_id: runId }));
    }
    const [, id, action] = req.url.match(/^\/v1\/runs\/(\d+)\/(events|stop)$/) ?? [];
    if (!runs.has(id)) return res.writeHead(404).end();
    if (action === 'stop') {
      stops.push(role);
      waiting.get(id)?.end('event: run.cancelled\ndata: {}\n\n');
      waiting.delete(id);
      return res.end('{}');
    }
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (runs.get(id).input === 'forged tool event') {
      send('message.delta', { delta: 'This partial answer must not be saved.' });
      send('tool.started', { tool: 'terminal', tool_call_id: 'illegal', preview: 'fixture' });
      return res.end();
    }
    if (runs.get(id).input === 'slow draft') {
      waiting.set(id, res);
      send('message.delta', { delta: 'This stopped draft must not be saved.' });
      slowDraftStarted = true;
      return;
    }
    send('message.delta', { delta: `${role} reply` });
    send('run.completed', {});
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, key, server };
}

async function start(config) {
  hq = spawn(process.execPath, ['server/dist/index.js'], {
    env: {
      ...process.env, DEV_LOGIN: '1', HQ_HOST: '127.0.0.1', PORT: '0',
      ALLOWED_EMAILS: '', HQ_LOCAL_ENGINES: '0', BOTHQ_NO_SCHEDULER: '1',
      HQ_DATA_DIR: root, DB_PATH: join(root, 'test.db'), APP_URL: 'http://localhost',
      SESSION_SECRET: 'fixture-local-session-secret', HQ_DRAFT_GATEWAYS: JSON.stringify(config),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  origin = await new Promise((resolve, reject) => {
    const child = hq;
    child.once('exit', (code) => reject(new Error(`Bot HQ exited with ${code}`)));
    child.stdout.on('data', (chunk) => {
      const port = String(chunk).match(/server on http:\/\/localhost:(\d+)/)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function stop() {
  if (!hq || hq.exitCode !== null) return;
  hq.kill();
  await once(hq, 'exit');
}

async function api(path, method = 'GET', body, status = 200, session = cookie) {
  const res = await fetch(origin + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: session ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return { res, data };
}

async function waitForRow(base, afterSeq, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { data } = await api(base + '/rows');
    const hit = data.rows.find((row) => row.seq > afterSeq && predicate(row.body));
    if (hit) return { hit, rows: data.rows };
    await delay(30);
  }
  assert.fail('Expected transcript row');
}

const ordinary = await gateway('ordinary');
const draft = await gateway('draft');
try {
  await start({});
  const login = await api('/auth/dev', 'POST', { email: 'draft@example.test' });
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  const { data: { bots: [bot] } } = await api('/bots');
  const base = `/bots/${bot.id}`;
  await api(base + '/agent', 'PUT', { hermesUrl: ordinary.url, hermesKey: ordinary.key, websockifyUrl: '', cdpPort: null });
  await api(base + '/messages', 'POST', { text: 'unconfigured draft', mode: 'draft' }, 409);
  assert.equal((await api(base + '/rows')).data.rows.length, 0);
  await stop();

  await start({ [bot.id]: { url: ordinary.url, key: ordinary.key } });
  await api(base + '/messages', 'POST', { text: 'same engine draft', mode: 'draft' }, 409);
  assert.equal(admissions.ordinary.length, 0);
  await stop();

  await start({ [bot.id]: { url: draft.url, key: draft.key } });
  assert.equal((await api('/bots')).data.bots[0].draftOnlyAvailable, true);
  await api(base + '/messages', 'POST', { text: 'unauthenticated', mode: 'draft' }, 401, '');
  await api(base + '/messages', 'POST', { text: 'bad mode', mode: 'unknown' }, 400);
  const send = async (text, mode) => (await api(base + '/messages', 'POST', { text, mode })).data.row;
  const reply = (expected) => (body) => body.role === 'assistant' && body.text === expected && !body.streaming;

  const regular = await send('private ordinary context');
  await waitForRow(base, regular.seq, reply('ordinary reply'));
  const first = await send('fictional sample', 'draft');
  assert.equal(first.body.draftOnly, true);
  await waitForRow(base, first.seq, reply('draft reply'));
  const second = await send('another sample', 'draft');
  await waitForRow(base, second.seq, reply('draft reply'));
  assert.equal(admissions.ordinary.length, 1);
  assert.equal(admissions.draft.length, 2);
  assert.notEqual(admissions.draft[0].session, admissions.draft[1].session);
  assert.notEqual(admissions.ordinary[0].session, admissions.draft[0].session);
  assert.equal(admissions.draft[0].payload.input, 'fictional sample');
  assert.doesNotMatch(JSON.stringify(admissions.draft[0].payload), /private ordinary context|draft@example.test|send_to_bot/);

  const forged = await send('forged tool event', 'draft');
  const { rows } = await waitForRow(base, forged.seq, (body) => body.type === 'notice' && body.tone === 'error');
  const failedRows = rows.filter((row) => row.seq > forged.seq);
  assert.deepEqual(failedRows.map((row) => row.kind), ['notice']);
  assert.deepEqual(stops, ['draft']);

  const slow = await send('slow draft', 'draft');
  for (let attempt = 0; !slowDraftStarted && attempt < 100; attempt++) await delay(30);
  assert.equal(slowDraftStarted, true);
  await api(base + '/interrupt', 'POST');
  const stopped = await waitForRow(base, slow.seq, (body) => body.type === 'notice' && body.text === 'Stopped.');
  assert.deepEqual(stopped.rows.filter((row) => row.seq > slow.seq).map((row) => row.kind), ['notice']);
  assert.deepEqual(stops, ['draft', 'draft']);

  draftAvailable = false;
  const offline = await send('offline draft', 'draft');
  await waitForRow(base, offline.seq, (body) => body.type === 'notice' && body.tone === 'error');
  assert.equal(admissions.ordinary.length, 1);
  console.log('Draft-only routing, transcript, fresh sessions, tool guard and no fallback passed.');

  if (process.env.HQ_TEST_CHROMIUM) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ executablePath: process.env.HQ_TEST_CHROMIUM });
    try {
      draftAvailable = true;
      const ctx = await browser.newContext({ viewport: { width: 430, height: 800 } });
      const [name, value] = cookie.split('=');
      await ctx.addCookies([{ name, value, url: origin }]);
      const page = await ctx.newPage();
      await page.goto(origin);
      const box = page.getByRole('textbox', { name: `Message ${bot.name}` });
      await box.fill('browser draft');
      await page.getByRole('button', { name: 'Draft only', exact: true }).click();
      await page.getByText('draft reply', { exact: true }).nth(2).waitFor();
      assert.equal(admissions.draft.at(-1).payload.input, 'browser draft');
      await box.fill('browser ordinary send');
      await box.press('Enter');
      await page.getByText('ordinary reply', { exact: true }).nth(1).waitFor();
      assert.equal(admissions.ordinary.at(-1).payload.input, 'browser ordinary send');
      console.log('Mobile-width browser can send a draft or send an ordinary message with Enter.');
    } finally {
      await browser.close();
    }
  }
} finally {
  await stop();
  ordinary.server.close();
  draft.server.close();
  await rm(root, { recursive: true, force: true });
}
