import { readFile } from 'node:fs/promises';
import { personalAssistantPaired, personalGmail } from '../agent/personal-assistant.js';
import { db } from '../db.js';
import { gmailPushClient } from './gmail.js';
import { gmailPushStore } from './store.js';
import { startGmailPushWorker, type EnqueueEvent } from './worker.js';

export function gmailPushConfig() {
  const projectId = process.env.HQ_GMAIL_PUSH_GCP_PROJECT;
  const topic = process.env.HQ_GMAIL_PUSH_TOPIC;
  const subscriptionName = process.env.HQ_GMAIL_PUSH_SUBSCRIPTION;
  const keyFilename = process.env.HQ_GMAIL_PUSH_CREDENTIALS;
  if (!projectId && !topic && !subscriptionName && !keyFilename) return;
  const botId = process.env.HQ_PERSONAL_BOT_ID;
  const mailbox = process.env.HQ_PERSONAL_GMAIL_MAILBOX;
  const gmail = personalGmail();
  if (!projectId || !topic || !subscriptionName || !keyFilename || !botId || !mailbox || !gmail) {
    console.error('[gmail-push] Missing Pub/Sub settings, Personal Assistant bot ID, or Owner Gmail grant.');
    return;
  }
  return { projectId, topicName: `projects/${projectId}/topics/${topic}`, subscriptionName, keyFilename, botId, mailbox, gmail };
}

export async function startGmailPush(config: NonNullable<ReturnType<typeof gmailPushConfig>>, enqueueEvent: EnqueueEvent) {
  const { projectId, topicName, subscriptionName, keyFilename, botId, mailbox, gmail } = config;
  // Keep filesystem errors and the credential path out of SDK diagnostics.
  const key = await readFile(keyFilename, 'utf8').then(text => JSON.parse(text)).catch(() => null);
  if (key?.type !== 'service_account' || typeof key.client_email !== 'string' || !key.client_email
      || typeof key.private_key !== 'string' || !key.private_key) {
    throw new Error('Gmail push service account key is unavailable or invalid');
  }
  const [{ PubSub }, { GoogleAuth, JWT }] = await Promise.all([
    import('@google-cloud/pubsub'), import('google-auth-library'),
  ]);
  const store = gmailPushStore(db, mailbox, botId);
  const auth = new GoogleAuth({
    projectId,
    authClient: new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/pubsub'] }),
  });
  const pubsub = new PubSub({ projectId, auth, enableTelemetryLogging: false });
  const subscription = pubsub.subscription(subscriptionName, {
    flowControl: { maxMessages: 32, allowExcessMessages: false },
    streamingOptions: { maxStreams: 1 },
  });
  const worker = startGmailPushWorker({
    gmail: gmailPushClient(gmail), subscription, store, botId, mailbox, topicName, enqueueEvent,
    canDeliver: () => personalAssistantPaired(botId),
    report: message => console.error('[gmail-push]', message),
  });
  return async () => {
    try {
      await worker.stop();
    } finally {
      await pubsub.close();
    }
  };
}
