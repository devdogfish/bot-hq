import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { PersonalGmail } from '../server/dist/agent/personal-gmail.js';
import { gmailPushClient, RESYNC_WINDOW_MS } from '../server/dist/gmail-push/gmail.js';
import { gmailPushStore } from '../server/dist/gmail-push/store.js';
import { startGmailPushWorker } from '../server/dist/gmail-push/worker.js';

const mailbox = 'owner@example.test';
const botId = 'tyler-personal-fixture';
const topicName = 'projects/gmail-project/topics/inbox';
const id = offset => (9007199254740992n + BigInt(offset)).toString();
const options = { timeout: 20000 };

class FakeSubscription extends EventEmitter {
  ready = new Promise(resolve => {
    this.on('newListener', event => { if (event === 'message') resolve(); });
  });

  publish(historyId, emailAddress = mailbox) {
    return new Promise(resolve => {
      assert.equal(this.emit('message', {
        data: Buffer.from(JSON.stringify({ emailAddress, historyId })),
        ack: () => resolve('ack'),
        nack: () => resolve('nack'),
      }), true, 'worker is pulling messages');
    });
  }

  async close() {
    this.emit('close');
  }
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bot-hq-gmail-push-'));
  const filename = join(directory, 'hq.db');
  let db;
  let worker;
  t.after(async () => {
    await worker?.stop();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const changes = new Map();
  const calls = { token: 0, watch: [], profiles: 0, history: [], recent: [], metadata: [], batches: [] };
  const events = new Map();
  const attempts = [];
  const reports = [];
  const fake = {
    changes, calls, events, attempts, reports,
    watchId: id(0),
    profileId: id(0),
    recent: [],
    metadataStatus: new Map(),
    enqueue: async event => {
      if (events.has(event.event_id)) return { status: 'duplicate' };
      events.set(event.event_id, event);
      return { status: 'accepted' };
    },
    async start() {
      db = new Database(filename);
      const store = gmailPushStore(db, mailbox, botId);
      const subscription = new FakeSubscription();
      const transport = new PersonalGmail({
        mailbox, clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh',
      }, async (input, request) => {
        const url = new URL(input);
        if (url.hostname === 'oauth2.googleapis.com') {
          calls.token++;
          assert.equal(request.body.get('refresh_token'), 'refresh');
          return Response.json({ access_token: 'fake-access-token', token_type: 'Bearer', expires_in: 3600 });
        }
        assert.equal(request.headers.authorization, 'Bearer fake-access-token');
        if (url.pathname === '/batch/gmail/v1') {
          assert.equal(request.method, 'POST');
          const marker = request.headers['content-type'].match(/^multipart\/mixed; boundary=(.+)$/)?.[1];
          assert.ok(marker);
          const [preamble, ...parts] = request.body.split('--' + marker);
          assert.equal(preamble, '');
          assert.equal(parts.pop(), '--\r\n');
          calls.batches.push(parts.length);
          const responses = parts.map(part => {
            const path = part.match(/^GET (\S+) HTTP\/1.1\r$/mu)?.[1];
            assert.ok(path);
            const subrequest = new URL(path, url);
            assert.match(subrequest.pathname, /^\/gmail\/v1\/users\/me\/messages\//);
            assert.equal(subrequest.searchParams.get('format'), 'METADATA');
            assert.deepEqual(subrequest.searchParams.getAll('metadataHeaders'), ['From', 'Subject']);
            assert.equal(subrequest.searchParams.get('fields'), 'id,payload(headers)');
            const id = subrequest.pathname.split('/').at(-1);
            calls.metadata.push(id);
            const status = fake.metadataStatus.get(id) ?? 200;
            const body = JSON.stringify({ id, payload: { headers: [
              { name: 'From', value: 'Sender <sender@example.test>' }, { name: 'Subject', value: 'Subject ' + id },
            ] } });
            return ['--fake-batch', 'Content-Type: application/http', '', 'HTTP/1.1 ' + status,
              'Content-Type: application/json', '', body, ''].join('\r\n');
          });
          await setImmediate();
          return new Response(responses.join('') + '--fake-batch--\r\n', {
            headers: { 'content-type': 'multipart/mixed; boundary="fake-batch"' },
          });
        }
        const api = url.pathname.replace('/gmail/v1/users/me/', '');
        if (api === 'profile') {
          if (url.searchParams.get('fields') === 'emailAddress') return Response.json({ emailAddress: mailbox });
          assert.equal(url.searchParams.get('fields'), 'historyId');
          calls.profiles++;
          return Response.json({ historyId: fake.profileId });
        }
        if (api === 'watch') {
          assert.equal(request.method, 'POST');
          calls.watch.push(JSON.parse(request.body));
          return Response.json({ historyId: fake.watchId, expiration: String(Date.now() + RESYNC_WINDOW_MS) });
        }
        const token = url.searchParams.get('pageToken');
        if (api === 'history') {
          assert.equal(url.searchParams.get('labelId'), 'INBOX');
          assert.equal(url.searchParams.get('historyTypes'), 'messageAdded');
          const start = url.searchParams.get('startHistoryId');
          calls.history.push([start, token]);
          const pages = changes.get(start);
          assert.notEqual(pages, undefined, 'unexpected start history ID ' + start);
          if (pages === null) return new Response(null, { status: 404 });
          const index = Number(token ?? 0);
          const { ids, historyId } = pages[index];
          return Response.json({
            historyId,
            history: [{ messagesAdded: ids.map(id => ({ message: { id } })) }],
            ...(index + 1 < pages.length && { nextPageToken: String(index + 1) }),
          });
        }
        if (api === 'messages') {
          assert.equal(url.searchParams.get('labelIds'), 'INBOX');
          assert.equal(url.searchParams.get('fields'), 'messages(id),nextPageToken');
          calls.recent.push([url.searchParams.get('q'), token]);
          const index = Number(token ?? 0);
          return Response.json({
            messages: fake.recent[index].map(id => ({ id })),
            ...(index + 1 < fake.recent.length && { nextPageToken: String(index + 1) }),
          });
        }
        assert.fail('Unexpected Gmail API call ' + api);
      });
      worker = startGmailPushWorker({
        gmail: gmailPushClient(transport),
        subscription, store, botId, mailbox, topicName, canDeliver: () => true,
        report: message => reports.push(message),
        enqueueEvent: async (actualBot, routine, event) => {
          assert.equal(actualBot, botId);
          assert.equal(routine, 'Gmail new mail');
          attempts.push(event.event_id);
          return fake.enqueue(event);
        },
      });
      await subscription.ready;
      return { subscription, store };
    },
    async stop() {
      await worker.stop();
      worker = undefined;
      db.close();
      db = undefined;
    },
  };
  return fake;
}

test('reopens the saved cursor and receipts after an interrupted enqueue', options, async t => {
  const fake = fixture(t);
  const first = await fake.start();
  assert.deepEqual(fake.calls.watch, [{ labelIds: ['INBOX'], labelFilterBehavior: 'include', topicName }]);
  assert.equal(first.store.cursor(), id(0));
  fake.changes.set(id(0), [{ historyId: id(2), ids: ['one', 'two'] }]);
  const accept = fake.enqueue;
  fake.enqueue = async event => {
    assert.equal(first.store.cursor(), id(0), 'cursor stays behind pending sends');
    if (event.event_id === 'two') {
      await accept(event);
      throw new Error('ingress accepted the event but HQ lost its receipt');
    }
    return accept(event);
  };
  assert.equal(await first.subscription.publish(id(2)), 'nack');
  assert.equal(first.store.cursor(), id(0));
  assert.deepEqual([...fake.events.keys()], ['one', 'two']);
  await fake.stop();

  fake.watchId = id(3);
  fake.changes.set(id(0), [{ historyId: id(3), ids: ['one', 'two', 'three'] }]);
  fake.enqueue = accept;
  const second = await fake.start();
  assert.equal(await second.subscription.publish(id(3)), 'ack');
  assert.equal(await second.subscription.publish(id(2)), 'ack');
  assert.equal(second.store.cursor(), id(3));
  assert.deepEqual(fake.attempts, ['one', 'two', 'two', 'three']);
  assert.deepEqual([...fake.events.keys()], ['one', 'two', 'three']);
  assert.deepEqual(fake.events.get('three'), {
    event_id: 'three', summary: 'Sender <sender@example.test> — Subject three', refs: { messageId: 'three' },
  });
  assert.deepEqual(fake.calls.history, [[id(0), null], [id(0), null]]);
  assert.deepEqual(fake.calls.metadata, ['one', 'two', 'two', 'three']);
});

test('a history 404 scans seven days of Inbox pages and catches arrivals during the scan', options, async t => {
  const fake = fixture(t);
  const first = await fake.start();
  fake.changes.set(id(0), [{ historyId: id(1), ids: ['seen'] }]);
  assert.equal(await first.subscription.publish(id(1)), 'ack');
  await fake.stop();
  fake.changes.set(id(1), null);
  fake.profileId = id(9);
  fake.recent = [['new1', 'seen'], ['new1', 'new2']];
  fake.changes.set(id(9), [{ historyId: id(11), ids: ['new2', 'arrived-during-scan'] }]);
  const { subscription, store } = await fake.start();
  const before = Math.floor((Date.now() - RESYNC_WINDOW_MS) / 1000);
  assert.equal(await subscription.publish(id(10)), 'ack');
  const after = Math.floor((Date.now() - RESYNC_WINDOW_MS) / 1000);
  const [[query, firstToken], [queryAgain, secondToken]] = fake.calls.recent;
  const seconds = Number(query.match(/^after:(\d+)$/)?.[1]);
  assert.ok(seconds >= before && seconds <= after);
  assert.equal(queryAgain, query);
  assert.deepEqual([firstToken, secondToken], [null, '1']);
  assert.equal(fake.calls.profiles, 1);
  assert.deepEqual(fake.calls.history, [[id(0), null], [id(1), null], [id(9), null]]);
  assert.deepEqual(fake.attempts, ['seen', 'new1', 'new2', 'arrived-during-scan']);
  assert.equal(store.cursor(), id(11));
  assert.equal(await subscription.publish(id(11)), 'ack');
  assert.equal(fake.calls.history.length, 3);
});

test('coalesces a 200-message burst across history pages into four metadata batches', options, async t => {
  const fake = fixture(t);
  const started = performance.now();
  const { subscription, store } = await fake.start();
  const startupMs = performance.now() - started;
  const ids = Array.from({ length: 200 }, (_, index) => 'mail-' + index);
  fake.changes.set(id(0), [
    { historyId: id(150), ids: ids.slice(0, 100) },
    { historyId: id(200), ids: ids.slice(99) },
  ]);
  assert.equal(await subscription.publish(id(201), 'other@example.test'), 'ack');
  const burstStarted = performance.now();
  const results = await Promise.all(ids.map((_, index) => subscription.publish(id(200 - index))));
  const burstMs = performance.now() - burstStarted;
  assert.ok(results.every(result => result === 'ack'));
  assert.deepEqual(fake.attempts, ids);
  assert.deepEqual(fake.calls.history, [[id(0), null], [id(0), '1']]);
  assert.deepEqual(fake.calls.metadata, ids);
  assert.deepEqual(fake.calls.batches, [50, 50, 50, 50]);
  assert.equal(fake.calls.token, 1);
  assert.equal(store.cursor(), id(200));
  assert.deepEqual(fake.reports, []);
  t.diagnostic(`Fake cold start ${startupMs.toFixed(1)} ms. Warm burst ${burstMs.toFixed(1)} ms for 2 history pages and 4 metadata batches.`);
});

test('retries a failed metadata part without advancing the cursor', options, async t => {
  const fake = fixture(t);
  const { subscription, store } = await fake.start();
  fake.changes.set(id(0), [{ historyId: id(3), ids: ['first', 'deleted', 'last'] }]);
  fake.metadataStatus.set('deleted', 404);
  fake.metadataStatus.set('last', 429);
  assert.equal(await subscription.publish(id(3)), 'nack');
  assert.equal(store.cursor(), id(0));
  assert.deepEqual(fake.attempts, []);
  fake.metadataStatus.delete('last');
  assert.equal(await subscription.publish(id(3)), 'ack');
  assert.equal(store.cursor(), id(3));
  assert.deepEqual(fake.attempts, ['first', 'last']);
});

test('keeps the cursor behind mail when the routine is unavailable', options, async t => {
  const fake = fixture(t);
  const { subscription, store } = await fake.start();
  fake.changes.set(id(0), [{ historyId: id(1), ids: ['waiting'] }]);
  const accept = fake.enqueue;
  fake.enqueue = async () => ({ status: 'unavailable' });
  assert.equal(await subscription.publish(id(1)), 'nack');
  assert.equal(store.cursor(), id(0));
  assert.equal(fake.events.size, 0);
  fake.enqueue = async event => {
    await accept(event);
    return { status: 'batched' };
  };
  assert.equal(await subscription.publish(id(1)), 'ack');
  assert.equal(store.cursor(), id(1));
  assert.deepEqual([...fake.events.keys()], ['waiting']);
});

test('renews the watch daily and catches up from the saved cursor without a notification', options, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fixture(t);
  const { subscription, store } = await fake.start();
  fake.watchId = id(1);
  fake.changes.set(id(0), [{ historyId: id(1), ids: ['missed-notification'] }]);
  t.mock.timers.tick(RESYNC_WINDOW_MS / 7);
  await setImmediate();
  await setImmediate();
  assert.equal(fake.calls.watch.length, 2);
  assert.equal(store.cursor(), id(1));
  assert.deepEqual(fake.attempts, ['missed-notification']);
  assert.equal(await subscription.publish(id(1)), 'ack');
  assert.deepEqual(fake.calls.history, [[id(0), null]]);
});
