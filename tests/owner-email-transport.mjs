import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageRejected, SESv2Client, SESv2ServiceException, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  deliverOwnerEmail, OWNER_EMAIL_ROLES, ownerEmailEnvelope, ownerEmailTransportConfigured,
} from '../server/dist/agent/owner-email-transport.js';

const packet = { role: 'tyler', subject: 'Mise à jour', body: 'Première ligne.\nDeuxième ligne.' };
const accessKey = 'BOT_HQ_EMAIL_SES_ACCESS_KEY_ID';
const secretKey = 'BOT_HQ_EMAIL_SES_SECRET_ACCESS_KEY';
const fromDomain = 'agents.example.org';
const recipients = ['owner@example.net', 'owner-two@example.net', 'owner@example.org'];
const mailEnvironment = {
  HQ_OWNER_EMAIL_FROM_DOMAIN: fromDomain,
  HQ_OWNER_EMAIL_TO: JSON.stringify(recipients),
};

function setEnvironment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
}

test('uses a fixed UTF-8 plain-text message for all Owner addresses and the selected role', async (t) => {
  setEnvironment(t, mailEnvironment);
  assert.deepEqual(OWNER_EMAIL_ROLES, ['tyler', 'stacy', 'sam']);
  for (const role of OWNER_EMAIL_ROLES) {
    const address = role + '@' + fromDomain;
    assert.deepEqual(ownerEmailEnvelope(role), { from: address, to: recipients });
    let attempts = 0;
    const result = await deliverOwnerEmail({ ...packet, role, to: 'unrelated@example.test', from: 'wrong@example.test' }, {
      async send(command, options) {
        attempts++;
        assert.ok(command instanceof SendEmailCommand);
        assert.ok(options.abortSignal instanceof AbortSignal);
        assert.equal(options.abortSignal.aborted, false);
        assert.deepEqual(command.input, {
          FromEmailAddress: address,
          Destination: { ToAddresses: recipients },
          Content: { Simple: {
            Subject: { Charset: 'UTF-8', Data: packet.subject },
            Body: { Text: { Charset: 'UTF-8', Data: packet.body } },
          } },
          ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } },
        });
        return { MessageId: 'fixture-message-id' };
      },
    });
    assert.deepEqual(result, { kind: 'accepted', messageId: 'fixture-message-id' });
    assert.equal(attempts, 1);
  }
});

test('uses only the explicit credentials, region, endpoint and one SDK attempt', async (t) => {
  setEnvironment(t, {
    ...mailEnvironment,
    [accessKey]: 'fixture-dedicated-key',
    [secretKey]: 'fixture-dedicated-secret',
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: 'https://unused.example.test',
    AWS_ACCESS_KEY_ID: 'fixture-ambient-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-ambient-secret',
    AWS_MAX_ATTEMPTS: '6',
    AWS_USE_FIPS_ENDPOINT: 'true',
  });
  assert.equal(ownerEmailTransportConfigured(), true);
  const send = t.mock.method(SESv2Client.prototype, 'send', async function () {
    const credentials = await this.config.credentials();
    assert.equal(credentials.accessKeyId, 'fixture-dedicated-key');
    assert.equal(credentials.secretAccessKey, 'fixture-dedicated-secret');
    assert.equal(await this.config.region(), 'ca-central-1');
    const endpoint = await this.config.endpoint();
    assert.equal(endpoint.protocol, 'https:');
    assert.equal(endpoint.hostname, 'email.ca-central-1.amazonaws.com');
    assert.equal(await this.config.maxAttempts(), 1);
    assert.equal(await this.config.useFipsEndpoint(), false);
    return { MessageId: 'fixture-message-id' };
  });

  assert.deepEqual(await deliverOwnerEmail(packet), { kind: 'accepted', messageId: 'fixture-message-id' });
  assert.equal(send.mock.callCount(), 1);
});

test('missing or blank dedicated credentials block the send despite ambient credentials', async (t) => {
  setEnvironment(t, {
    ...mailEnvironment,
    [accessKey]: 'fixture-dedicated-key',
    [secretKey]: ' ',
    AWS_ACCESS_KEY_ID: 'fixture-ambient-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-ambient-secret',
  });
  const send = t.mock.method(SESv2Client.prototype, 'send', async () => ({ MessageId: 'unexpected' }));
  assert.equal(ownerEmailTransportConfigured(), false);
  assert.deepEqual(await deliverOwnerEmail(packet), { kind: 'rejected' });
  assert.equal(send.mock.callCount(), 0);
});

test('missing or malformed envelope configuration blocks provider I/O', async (t) => {
  setEnvironment(t, { ...mailEnvironment, [accessKey]: 'fixture-key', [secretKey]: 'fixture-secret' });
  const sender = { send: t.mock.fn(async () => ({ MessageId: 'unexpected' })) };
  for (const domain of ['', 'agents.Example.org', 'agents.example.org.', '-agent.example.org', '127.0.0.1',
    'https://agents.example.org', 'agents.example.org\n', 'localhost']) {
    process.env.HQ_OWNER_EMAIL_FROM_DOMAIN = domain;
    assert.equal(ownerEmailEnvelope('tyler'), undefined);
    assert.equal(ownerEmailTransportConfigured(), false);
    assert.deepEqual(await deliverOwnerEmail(packet, sender), { kind: 'rejected' });
  }

  process.env.HQ_OWNER_EMAIL_FROM_DOMAIN = fromDomain;
  for (const to of ['', 'invalid JSON', JSON.stringify(recipients.slice(1)),
    JSON.stringify([recipients[0], recipients[0], recipients[1]])]) {
    process.env.HQ_OWNER_EMAIL_TO = to;
    assert.equal(ownerEmailEnvelope('tyler'), undefined);
    assert.equal(ownerEmailTransportConfigured(), false);
    assert.deepEqual(await deliverOwnerEmail(packet, sender), { kind: 'rejected' });
  }
  assert.equal(sender.send.mock.callCount(), 0);
});

test('invalid role, subject or body cannot trigger provider I/O', async (t) => {
  setEnvironment(t, mailEnvironment);
  const sender = { send: t.mock.fn(async () => ({ MessageId: 'unexpected' })) };
  for (const changes of [
    { role: 'owner' }, { role: 'toString' }, { role: '__proto__' }, { role: ['tyler'] },
    { subject: 'Envoi\r\nBcc: unrelated@example.test' }, { subject: 'x'.repeat(201) },
    { subject: 12 }, { subject: '  ' },
    { body: 'x'.repeat(10_001) }, { body: ' ' }, { body: 'one\u0000two' },
  ]) {
    assert.deepEqual(await deliverOwnerEmail({ ...packet, ...changes }, sender), { kind: 'rejected' });
  }
  assert.equal(sender.send.mock.callCount(), 0);
});

test('only documented SES refusals with matching statuses count as rejected', async (t) => {
  setEnvironment(t, mailEnvironment);
  for (const [error, expected] of [
    [new MessageRejected({ message: 'fixture secret', $metadata: { httpStatusCode: 400 } }), 'rejected'],
    [new MessageRejected({ message: 'fixture secret', $metadata: { httpStatusCode: 500 } }), 'uncertain'],
    [new SESv2ServiceException({
      name: 'UnexpectedRefusal', message: 'fixture secret', $fault: 'client', $metadata: { httpStatusCode: 400 },
    }), 'uncertain'],
    [Object.assign(new Error('fixture secret'), { name: 'MessageRejected', $metadata: { httpStatusCode: 400 } }), 'uncertain'],
    [new DOMException('fixture secret', 'TimeoutError'), 'uncertain'],
    [new Error('fixture secret'), 'uncertain'],
  ]) {
    const sender = { send: t.mock.fn(async () => { throw error; }) };
    assert.deepEqual(await deliverOwnerEmail(packet, sender), { kind: expected });
    assert.equal(sender.send.mock.callCount(), 1);
  }
});

test('a reply without a usable SES message ID leaves delivery uncertain', async (t) => {
  setEnvironment(t, mailEnvironment);
  for (const MessageId of [undefined, '', '  ']) {
    assert.deepEqual(await deliverOwnerEmail(packet, { async send() { return { MessageId }; } }), { kind: 'uncertain' });
  }
});
