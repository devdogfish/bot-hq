import { personalAssistantPaired, personalGmail } from '../agent/personal-assistant.js';
import { db } from '../db.js';
import { gmailPushClient } from './gmail.js';
import { gmailPushStore } from './store.js';
import { startGmailPushWorker, type EnqueueEvent } from './worker.js';

export const enqueueEventStub: EnqueueEvent = () => {
  console.error('[gmail-push] Event ingress unavailable. Wire #585 before enabling Gmail delivery.');
  throw new Error('Event ingress unavailable');
};

export function gmailPushConfig() {
  const projectId = process.env.HQ_GMAIL_PUSH_GCP_PROJECT;
  const topic = process.env.HQ_GMAIL_PUSH_TOPIC;
  const subscriptionName = process.env.HQ_GMAIL_PUSH_SUBSCRIPTION;
  const keyFilename = process.env.HQ_GMAIL_PUSH_CREDENTIALS;
  if (!projectId && !topic && !subscriptionName && !keyFilename) return;
  const botId = process.env.HQ_TYLER_PERSONAL_BOT_ID;
  const mailbox = process.env.HQ_TYLER_GMAIL_MAILBOX;
  const gmail = personalGmail();
  if (!projectId || !topic || !subscriptionName || !keyFilename || !botId || !mailbox || !gmail) {
    console.error('[gmail-push] Missing Pub/Sub settings, Tyler Personal bot ID, or Owner Gmail grant.');
    return;
  }
  return { projectId, topicName: `projects/${projectId}/topics/${topic}`, subscriptionName, keyFilename, botId, mailbox, gmail };
}

export async function startGmailPush(config: NonNullable<ReturnType<typeof gmailPushConfig>>, enqueueEvent: EnqueueEvent) {
  const { PubSub } = await import('@google-cloud/pubsub');
  const { projectId, topicName, subscriptionName, keyFilename, botId, mailbox, gmail } = config;
  const store = gmailPushStore(db, mailbox, botId);
  const pubsub = new PubSub({ projectId, keyFilename });
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
