import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { PersonalGmail } from '../server/dist/agent/personal-gmail.js';

const config = {
  mailbox: 'owner@example.net', clientId: 'fake-client', clientSecret: 'fake-secret', refreshToken: 'fake-refresh',
};
const token = { access_token: 'fake-access', token_type: 'Bearer', expires_in: 3600 };
const header = (name, value) => ({ name, value });
const part = (mimeType, text, extra = {}) => ({ mimeType, body: { data: Buffer.from(text).toString('base64url') }, ...extra });
const payloadHeaders = [
  header('From', 'Alice <alice@example.net>'), header('Reply-To', '"Bookings, Inc." <booking@example.org>'),
  header('Subject', 'Confirm café'), header('Date', 'Tue, 17 Nov 2026 13:00:00 -0400'),
  header('Message-ID', '<current@example.net>'), header('References', '<parent@example.net>'),
];
const fixtureMessage = (id = 'm1', fields = {}) => ({
  id, threadId: 't1', labelIds: ['INBOX', 'UNREAD'],
  payload: {
    mimeType: 'multipart/mixed', headers: payloadHeaders,
    parts: [
      part('text/plain', 'attachment token', { filename: 'private.txt' }),
      part('text/plain', 'other attachment token', {
        headers: [header('Content-Disposition', 'attachment')],
      }),
      part('text/html', '<p>raw html token</p>'),
      { mimeType: 'multipart/alternative', parts: [part('text/plain', 'Please confirm Tuesday at 13:00.')] },
    ],
    ...fields,
  },
});

function fakeProvider(handler, options = {}) {
  const calls = [];
  const client = new PersonalGmail({ ...config, mailboxActions: options.mailboxActions }, async (input, request) => {
    const url = new URL(input);
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    calls.push({ url, request });
    if (url.origin === 'https://oauth2.googleapis.com') {
      assert.equal(url.pathname, '/token');
      assert.equal(request.method, 'POST');
      assert.deepEqual(Object.fromEntries(request.body), {
        client_id: config.clientId, client_secret: config.clientSecret,
        refresh_token: config.refreshToken, grant_type: 'refresh_token',
      });
      if (options.tokenGate) await options.tokenGate;
      return Response.json(options.token ?? token);
    }
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    assert.equal(request.headers.authorization, 'Bearer ' + token.access_token);
    if (url.pathname.endsWith('/profile')) {
      assert.equal(url.searchParams.get('fields'), 'emailAddress');
      return Response.json({ emailAddress: options.mailbox ?? config.mailbox });
    }
    return handler(url, request);
  });
  return { client, calls };
}

test('shares one verified token across concurrent reads and bounds inbox page requests', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
  const { client, calls } = fakeProvider(async (url) => {
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('labelIds'), 'INBOX');
      assert.equal(url.searchParams.get('pageToken'), 'previous+=/page');
      assert.equal(url.searchParams.get('maxResults'), '8');
      return Response.json({ messages: ids.map((id) => ({ id })), nextPageToken: 'next-page' });
    }
    if (url.searchParams.get('format') === 'METADATA') {
      assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date']);
      assert.equal(url.searchParams.get('fields'), 'id,threadId,labelIds,payload(headers)');
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await delay(5);
      concurrent--;
    }
    return Response.json(fixtureMessage(url.pathname.split('/').at(-1)));
  });
  const [page, read] = await Promise.all([client.list({ pageToken: 'previous+=/page' }), client.read('m1')]);
  assert.deepEqual(page.messages.map((message) => message.id), ids);
  assert.equal(page.nextPageToken, 'next-page');
  assert.equal(maxConcurrent, 4);
  assert.equal(read.text, 'Please confirm Tuesday at 13:00.');
  assert.equal(read.bodyStatus, 'plain_text');
  assert.equal(calls.length, 12, 'one token, one profile, one page, eight header reads and one full message');
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/token')).length, 1);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('/profile')).length, 1);
  assert.equal(await client.read('m1').then((message) => message.from), 'Alice <alice@example.net>');
  assert.equal(calls.length, 13, 'a warm message read does not repeat token or profile verification');
});

test('rejects an unpinned account, overbroad token and out-of-inbox message before exposing data', async () => {
  const wrongAccount = fakeProvider(() => assert.fail('wrong mailbox reached Gmail data'), { mailbox: 'other@example.net' });
  await assert.rejects(wrongAccount.client.read('m1'), /^Error: Personal Gmail is unavailable\.$/u);
  assert.equal(wrongAccount.calls.length, 2);
  const broad = fakeProvider(() => assert.fail('overbroad scopes reached Gmail data'), {
    token: { ...token, scope: 'https://mail.google.com/' },
  });
  await assert.rejects(broad.client.list(), /^Error: Personal Gmail is unavailable\.$/u);
  assert.equal(broad.calls.length, 1);
  const archived = fakeProvider(() => Response.json({ ...fixtureMessage(), labelIds: [] }));
  await assert.rejects(archived.client.read('m1'), /^Error: Personal Gmail is unavailable\.$/u);
  const tooLarge = fakeProvider(() => new Response('x'.repeat(1_048_577)));
  await assert.rejects(tooLarge.client.read('m1'), /^Error: Personal Gmail is unavailable\.$/u);
  await assert.rejects(tooLarge.client.read('../profile'), /^Error: Personal Gmail is unavailable\.$/u);
  assert.equal(tooLarge.calls.length, 3);
});

test('sends a plain-text reply once with the exact approved recipient and source thread', async () => {
  let submits = 0;
  const { client, calls } = fakeProvider((url, request) => {
    if (!url.pathname.endsWith('/send')) return Response.json(fixtureMessage());
    submits++;
    const { raw, threadId } = JSON.parse(request.body);
    assert.equal(threadId, 't1');
    const [headers, body] = Buffer.from(raw, 'base64url').toString().split('\r\n\r\n');
    assert.match(headers, /^From: owner@example\.net\r\nTo: booking@example\.org\r\n/u);
    assert.equal(headers.includes('Subject: =?UTF-8?B?' + Buffer.from('Confirm café').toString('base64') + '?='), true);
    assert.match(headers, /In-Reply-To: <current@example\.net>\r\nReferences: <parent@example\.net>\r\n <current@example\.net>/u);
    assert.match(headers, /Content-Type: text\/plain; charset=UTF-8/u);
    assert.doesNotMatch(headers, /\r\n(?:Bcc|Cc):/iu);
    assert.equal(Buffer.from(body, 'base64').toString(), 'Tuesday works.\r\nThanks!');
    return Response.json({ id: 'sent-message', threadId: 't1' });
  });
  const { reply } = await client.read('m1');
  assert.equal(reply.to, 'booking@example.org');
  assert.equal(await client.send({ ...reply, to: 'good@example.net\r\nBcc: evil@example.net' }, 'ok', () => true).then((value) => value.kind), 'rejected');
  assert.equal(await client.send({ ...reply, from: 'wrong@example.net' }, 'ok', () => true).then((value) => value.kind), 'rejected');
  assert.deepEqual(await client.send(reply, 'Tuesday works.\nThanks!', () => true), {
    kind: 'accepted', messageId: 'sent-message',
  });
  assert.equal(submits, 1);
  assert.equal(calls.length, 4);
});

test('treats ambiguous source recipients as read-only and never retries an uncertain send', async () => {
  let submits = 0;
  const { client } = fakeProvider((url) => {
    if (url.pathname.endsWith('/send')) {
      submits++;
      throw new Error('private provider response must stay internal');
    }
    return Response.json(fixtureMessage());
  });
  const { reply } = await client.read('m1');
  assert.deepEqual(await client.send(reply, 'ok', () => true), { kind: 'uncertain' });
  assert.equal(submits, 1);
  const invalid = fakeProvider(() => Response.json(fixtureMessage('m1', {
    headers: payloadHeaders.map(({ name, value }) => header(name, name === 'Reply-To'
      ? 'booking@example.org, unexpected@example.net' : value)),
  })));
  assert.equal((await invalid.client.read('m1')).reply, null);
});

test('reads HTML-only mail as static text without tracking elements or link destinations', async () => {
  const { client, calls } = fakeProvider(() => Response.json({
    ...fixtureMessage(), payload: part('text/html', [
      '<html><head><title>tracking metadata</title></head><body><p>Tuesday &amp; Thursday.</p>',
      '<a href="https://example.net/secret-destination">Confirm availability</a>',
      '<img alt="tracking alt" src="https://example.net/private">',
      '<script>script content</script><style>style content</style><noscript>noscript content</noscript>',
      '<iframe src="https://example.net/frame">frame content</iframe>',
      '<div hidden>hidden content</div><div aria-hidden="true">hidden aria content</div></body></html>',
    ].join(''), { headers: payloadHeaders }),
  }));
  const message = await client.read('m1');
  assert.equal(message.bodyStatus, 'plain_text');
  assert.equal(message.text, 'Tuesday & Thursday.\n\nConfirm availability');
  assert.equal(message.reply.to, 'booking@example.org');
  assert.equal(calls.length, 3, 'conversion makes no network requests');
});

test('reports a body with no safe visible text as unavailable and withholds its reply target', async () => {
  const { client } = fakeProvider(() => Response.json({
    ...fixtureMessage(), payload: part('text/html', '<img src="https://example.net/private"><script>tracking()</script>', {
      headers: payloadHeaders,
    }),
  }));
  const message = await client.read('m1');
  assert.equal(message.bodyStatus, 'unavailable');
  assert.equal(message.text, '');
  assert.equal(message.reply, null);
  assert.equal(message.subject, 'Confirm café');
});

test('uses the inbox thread index to read only the latest four eligible messages', async () => {
  const labels = {
    m1: ['INBOX'], m2: [], m3: ['SENT'], m4: ['INBOX'], m5: ['SENT'], m6: ['DRAFT'], m7: ['TRASH'], m8: ['SPAM'],
  };
  const { client, calls } = fakeProvider((url) => {
    const id = url.pathname.split('/').at(-1);
    if (url.pathname.includes('/threads/')) {
      assert.equal(url.searchParams.get('format'), 'MINIMAL');
      assert.equal(url.searchParams.get('fields'), 'id,messages(id,labelIds)');
      return Response.json({ id, messages: Object.entries(labels).map(([messageId, labelIds]) => ({ id: messageId, labelIds })) });
    }
    return Response.json({ ...fixtureMessage(id), labelIds: labels[id] });
  });
  const thread = await client.thread('t1');
  assert.equal(thread.threadId, 't1');
  assert.deepEqual(thread.messages.map((message) => message.id), ['m2', 'm3', 'm4', 'm5']);
  assert.ok(thread.messages.every((message) => message.text.includes('confirm') && !('reply' in message)));
  assert.equal(calls.length, 7, 'one refresh, profile, index, and four bodies');
  const archived = fakeProvider(() => Response.json({ id: 't1', messages: [{ id: 'm1', labelIds: ['SENT'] }] }));
  await assert.rejects(archived.client.thread('t1'), /^Error: Personal Gmail is unavailable\.$/u);
  assert.equal(archived.calls.length, 3, 'no bodies fetched for a thread outside the inbox');
});

test('checks turn eligibility again after a cold OAuth refresh and never submits after Stop', async () => {
  let release;
  const tokenGate = new Promise((resolve) => { release = resolve; });
  const { client, calls } = fakeProvider(() => assert.fail('a stopped turn reached the send endpoint'), { tokenGate });
  const draft = {
    from: config.mailbox, to: 'booking@example.org', subject: 'Scheduling',
    threadId: 't1', inReplyTo: '<current@example.net>', references: ['<current@example.net>'],
  };
  let approved = true;
  const sending = client.send(draft, 'Tuesday works', () => approved);
  assert.equal(calls.length, 1, 'OAuth refresh started while the turn was eligible');
  approved = false;
  release();
  assert.deepEqual(await sending, { kind: 'rejected' });
  assert.equal(calls.length, 2);
});


test('filters unread inbox mail using Gmail labels and preserves pagination', async () => {
  const { client } = fakeProvider(url => {
    if (url.pathname.endsWith('/messages')) {
      assert.deepEqual(url.searchParams.getAll('labelIds'), ['INBOX', 'UNREAD']);
      assert.equal(url.searchParams.get('pageToken'), 'next-unread');
      return Response.json({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'more' });
    }
    const id = url.pathname.split('/').at(-1);
    const message = fixtureMessage(id);
    if (id === 'm2') message.labelIds = ['INBOX'];
    return Response.json(message);
  });
  const page = await client.list({ unreadOnly: true, pageToken: 'next-unread' });
  assert.deepEqual(page.messages.map(({ id, unread }) => [id, unread]), [['m1', true]]);
  assert.equal(page.nextPageToken, 'more');
  assert.equal((await client.read('m2')).unread, false);
});

test('operations use only the pinned mailbox, one message, and the verified full grant', async () => {
  const requests = [];
  const { client } = fakeProvider((url, options) => {
    requests.push([url.pathname.split('/').slice(5).join('/'), options.method, options.body && JSON.parse(options.body)]);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/labels')) return Response.json({ labels: [
      { id: 'Label_12', type: 'user', name: 'Receipts' }, { id: 'INBOX', type: 'system', name: 'Inbox' },
    ] });
    return Response.json({ id: 'm1' });
  }, { mailboxActions: true, token: { ...token, scope: 'https://mail.google.com/' } });
  assert.deepEqual(await client.labels(), [{ id: 'Label_12', name: 'Receipts' }]);
  assert.equal(await client.changeMessage('m1', 'archive', undefined, () => true), 'changed');
  assert.equal(await client.changeMessage('m1', 'trash', undefined, () => true), 'changed');
  assert.equal(await client.changeMessage('m1', 'add_label', 'Label_12', () => true), 'changed');
  assert.equal(await client.changeMessage('m1', 'remove_label', 'Label_12', () => true), 'changed');
  assert.equal(await client.changeMessage('m1', 'add_label', 'INBOX', () => true), 'unavailable');
  assert.equal(await client.changeMessage('m1', 'delete', undefined, () => false), 'unavailable');
  assert.equal(await client.changeMessage('m1', 'delete', undefined, () => true), 'changed');
  assert.deepEqual(requests, [
    ['labels', undefined, undefined],
    ['messages/m1/modify', 'POST', { removeLabelIds: ['INBOX'] }],
    ['messages/m1/trash', 'POST', undefined],
    ['messages/m1/modify', 'POST', { addLabelIds: ['Label_12'] }],
    ['messages/m1/modify', 'POST', { removeLabelIds: ['Label_12'] }],
    ['messages/m1', 'DELETE', undefined],
  ]);
  const readonly = fakeProvider(() => assert.fail('read-only credential reached a write endpoint'));
  assert.equal(await readonly.client.changeMessage('m1', 'delete', undefined, () => true), 'unavailable');
  assert.equal(readonly.calls.length, 0);
});
