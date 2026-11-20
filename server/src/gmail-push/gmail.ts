import { randomUUID } from 'node:crypto';
import type { PersonalGmail } from '../agent/personal-gmail.js';

export const RESYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const METADATA_BATCH_SIZE = 50;
const PAGE_BYTES = 1_048_576;
const METADATA_QUERY = 'format=METADATA&metadataHeaders=From&metadataHeaders=Subject&fields=id,payload(headers)';

interface MessageMetadata {
  from: string;
  subject: string;
}

export interface GmailPushClient {
  watch(topicName: string): Promise<string>;
  history(startHistoryId: string): Promise<{ historyId: string; messageIds: string[] } | null>;
  currentHistoryId(): Promise<string>;
  recentInbox(after: number): Promise<string[]>;
  metadata(messageIds: string[]): Promise<(MessageMetadata | null)[]>;
}

export function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/u.test(value);
}

function historyId(value: unknown): string {
  if (!isHistoryId(value)) throw new Error('Invalid Gmail history ID');
  return value;
}

function gmailMessageId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,128}$/u.test(value)) throw new Error('Invalid Gmail message ID');
  return value;
}

function entries(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid Gmail result');
  return value;
}

function nextPage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new Error('Invalid Gmail page token');
  return value;
}

function parseMetadata(part: string, messageId: string): MessageMetadata | null {
  const separator = part.indexOf('\n\n');
  if (separator < 0) throw new Error('Invalid Gmail batch part');
  const response = part.slice(separator + 2);
  const status = /^HTTP\/1\.[01] (\d{3})\b/u.exec(response)?.[1];
  // The message may have been permanently deleted after it appeared in history.
  if (status === '404') return null;
  if (status !== '200') throw new Error('Gmail metadata request failed');
  const headersEnd = response.indexOf('\n\n');
  if (headersEnd < 0) throw new Error('Invalid Gmail batch part');
  const page = JSON.parse(response.slice(headersEnd + 2));
  if (page.id !== messageId) throw new Error('Unexpected Gmail message ID');
  const headers = entries(page.payload?.headers);
  function header(name: string) {
    const value = headers.find(item => typeof item.name === 'string' && item.name.toLowerCase() === name)?.value;
    return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/gu, ' ').trim() : '';
  }
  return { from: header('from') || '(unknown sender)', subject: header('subject') || '(no subject)' };
}

export function gmailPushClient(gmail: Pick<PersonalGmail, 'pushRequest' | 'pushMetadataBatch'>): GmailPushClient {
  return {
    async watch(topicName) {
      return historyId((await gmail.pushRequest('watch', 4096, topicName))?.historyId);
    },
    async currentHistoryId() {
      return historyId((await gmail.pushRequest('profile?fields=historyId', 4096))?.historyId);
    },
    async history(startHistoryId) {
      const query = new URLSearchParams({
        startHistoryId, labelId: 'INBOX', historyTypes: 'messageAdded', maxResults: '500',
        fields: 'history(messagesAdded(message(id)),id),historyId,nextPageToken',
      });
      const ids = new Set<string>();
      for (;;) {
        const page = await gmail.pushRequest(`history?${query}`, PAGE_BYTES);
        if (page === null) return null;
        for (const record of entries(page.history)) {
          for (const item of entries(record.messagesAdded)) {
            ids.add(gmailMessageId((item.message as { id?: unknown })?.id));
          }
        }
        const token = nextPage(page.nextPageToken);
        if (!token) return { historyId: historyId(page.historyId), messageIds: [...ids] };
        query.set('pageToken', token);
      }
    },
    async recentInbox(after) {
      const query = new URLSearchParams({
        labelIds: 'INBOX', q: `after:${Math.floor(after / 1000)}`, maxResults: '500',
        fields: 'messages(id),nextPageToken',
      });
      const ids = new Set<string>();
      for (;;) {
        const page = await gmail.pushRequest(`messages?${query}`, PAGE_BYTES);
        if (!page) throw new Error('Gmail inbox unavailable');
        for (const message of entries(page.messages)) ids.add(gmailMessageId(message.id));
        const token = nextPage(page.nextPageToken);
        if (!token) return [...ids];
        query.set('pageToken', token);
      }
    },
    async metadata(messageIds) {
      // Gmail returns the parts in the order requested. The message ID verifies each successful part.
      const boundary = 'hq_' + randomUUID();
      const request = messageIds.map(id => [
        `--${boundary}`, 'Content-Type: application/http', '',
        `GET /gmail/v1/users/me/messages/${gmailMessageId(id)}?${METADATA_QUERY} HTTP/1.1`, '', '',
      ].join('\r\n')).join('') + `--${boundary}--\r\n`;
      const { contentType, body } = await gmail.pushMetadataBatch(boundary, request, 32_768 * messageIds.length);
      const responseBoundary = /^multipart\/mixed\s*;[^\n]*\bboundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType ?? '');
      const marker = responseBoundary?.[1] ?? responseBoundary?.[2];
      if (!marker) throw new Error('Invalid Gmail batch response');
      const [preamble, ...parts] = ('\n' + body.replace(/\r\n/gu, '\n')).split('\n--' + marker);
      if (preamble.trim() || parts.pop()?.trim() !== '--' || parts.length !== messageIds.length) {
        throw new Error('Incomplete Gmail batch response');
      }
      return parts.map((part, index) => parseMetadata(part, messageIds[index]));
    },
  };
}
