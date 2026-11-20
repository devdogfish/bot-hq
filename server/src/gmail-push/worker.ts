import { isHistoryId, METADATA_BATCH_SIZE, RESYNC_WINDOW_MS, type GmailPushClient } from './gmail.js';
import type { EnqueueEventResult } from '../events.js';
import type { gmailPushStore } from './store.js';

const WATCH_RENEWAL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60_000;
const ROUTINE = 'Gmail new mail';

type EnqueueResult = EnqueueEventResult | { status: 'batched' };

export type EnqueueEvent = (botId: string, routineName: string, event: {
  event_id: string;
  summary: string;
  refs: { messageId: string };
}) => EnqueueResult | Promise<EnqueueResult>;

interface Notification {
  data: Buffer;
  ack(): void;
  nack(): void;
}

interface Subscription {
  on(event: 'message', handler: (message: Notification) => void): unknown;
  on(event: 'error' | 'close', handler: () => void): unknown;
  removeListener(event: 'message', handler: (message: Notification) => void): unknown;
  removeListener(event: 'error' | 'close', handler: () => void): unknown;
  close(): Promise<void>;
}

interface Options {
  gmail: GmailPushClient;
  subscription: Subscription;
  store: ReturnType<typeof gmailPushStore>;
  enqueueEvent: EnqueueEvent;
  canDeliver: () => boolean;
  botId: string;
  mailbox: string;
  topicName: string;
  report: (message: string) => void;
}

function newer(candidate: string, cursor: string) {
  return BigInt(candidate) > BigInt(cursor);
}

function notificationId(message: Notification, mailbox: string): string | undefined {
  if (message.data.length > 4096) return;
  try {
    const { emailAddress, historyId } = JSON.parse(message.data.toString());
    if (typeof emailAddress === 'string' && emailAddress.toLowerCase() === mailbox && isHistoryId(historyId)) {
      return historyId;
    }
  } catch {
    // Malformed notifications cannot be processed by retrying.
  }
}

export function startGmailPushWorker({ gmail, subscription, store, enqueueEvent, canDeliver, botId, mailbox, topicName, report }: Options) {
  const pending: { historyId: string; message?: Notification }[] = [];
  let stopped = false;
  let listening = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let renewal: Promise<void>;

  async function deliver(ids: Iterable<string>) {
    const unseen = [...new Set(ids)].filter(id => !store.delivered(id));
    for (let offset = 0; offset < unseen.length; offset += METADATA_BATCH_SIZE) {
      const batch = unseen.slice(offset, offset + METADATA_BATCH_SIZE);
      const results = await gmail.metadata(batch);
      const delivered: string[] = [];
      try {
        for (const [index, headers] of results.entries()) {
          if (!headers) continue;
          if (!canDeliver()) throw new Error('Tyler Personal pairing unavailable');
          const id = batch[index];
          const { from, subject } = headers;
          const result = await enqueueEvent(botId, ROUTINE, {
            event_id: id, summary: `${from} — ${subject}`, refs: { messageId: id },
          });
          if (result.status !== 'accepted' && result.status !== 'duplicate' && result.status !== 'batched') {
            throw new Error('Gmail routine could not accept the event');
          }
          delivered.push(id);
        }
      } finally {
        // Ingress deduplicates by event_id if HQ crashes before these receipts are written.
        if (delivered.length) store.markDelivered(delivered);
      }
    }
  }

  async function sync(target: string) {
    const cursor = store.cursor();
    if (!cursor) throw new Error('Gmail watch is not initialized');
    if (!newer(target, cursor)) return;
    if (!canDeliver()) throw new Error('Tyler Personal pairing unavailable');
    let changes = await gmail.history(cursor);
    if (!changes) {
      // Take the anchor before listing so concurrent arrivals can be replayed from it.
      const cutoff = Date.now() - RESYNC_WINDOW_MS;
      const anchor = await gmail.currentHistoryId();
      const recent = await gmail.recentInbox(cutoff);
      changes = await gmail.history(anchor);
      if (!changes) throw new Error('Gmail resync anchor expired');
      await deliver([...recent, ...changes.messageIds]);
    } else {
      await deliver(changes.messageIds);
    }
    store.saveCursor(changes.historyId);
    if (newer(target, changes.historyId)) throw new Error('Gmail history has not reached the notification yet');
  }

  function queue(historyId: string, message?: Notification) {
    pending.push({ historyId, message });
    draining ??= Promise.resolve().then(async () => {
      try {
        while (pending.length && !stopped) {
          const batch = pending.splice(0);
          const target = batch.reduce((max, item) => newer(item.historyId, max) ? item.historyId : max, '0');
          try {
            await sync(target);
            for (const { message } of batch) message?.ack();
          } catch {
            report('Gmail delivery failed. Unacknowledged notifications will retry.');
            for (const { message } of batch) message?.nack();
          }
        }
      } finally {
        draining = undefined;
      }
    });
  }

  function receive(message: Notification) {
    const id = notificationId(message, mailbox.toLowerCase());
    if (!id) message.ack();
    else if (stopped) message.nack();
    else queue(id, message);
  }

  function subscriptionError() {
    report('Pub/Sub subscription stream error. Check the subscription and service account.');
  }

  function subscriptionClosed() {
    if (stopped || reconnect) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      subscription.removeListener('message', receive);
      subscription.on('message', receive);
    }, RETRY_MS);
    reconnect.unref();
  }

  async function renew() {
    let delay = WATCH_RENEWAL_MS;
    try {
      const id = await gmail.watch(topicName);
      if (stopped) return;
      // First installation starts at the watch baseline. Renewal never resets an existing cursor.
      if (!store.cursor()) store.saveCursor(id);
      if (!listening) {
        subscription.on('message', receive);
        listening = true;
      }
      // A successful watch also supplies a watermark if its notification is delayed or dropped.
      queue(id);
    } catch {
      delay = RETRY_MS;
      report('Gmail watch failed. Retrying in one minute.');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { renewal = renew(); }, delay);
        timer.unref();
      }
    }
  }

  subscription.on('error', subscriptionError);
  subscription.on('close', subscriptionClosed);
  renewal = renew();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(reconnect);
      for (const { message } of pending.splice(0)) message?.nack();
      await Promise.all([renewal, draining]);
      try {
        await subscription.close();
      } finally {
        subscription.removeListener('message', receive);
        subscription.removeListener('error', subscriptionError);
        subscription.removeListener('close', subscriptionClosed);
      }
    },
  };
}
