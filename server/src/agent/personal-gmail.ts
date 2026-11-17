import { compile } from 'html-to-text';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const TOKEN = 'https://oauth2.googleapis.com/token';
const PAGE_SIZE = 8;
const METADATA_CONCURRENCY = 4;
const THREAD_SIZE = 4;
const MAX_TEXT = 16_000;
const MAX_HTML = 96_000;
const FULL_MAILBOX_SCOPE = 'https://mail.google.com/';
const GMAIL_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]);
const htmlToText = compile({
  wordwrap: false,
  limits: { maxInputLength: MAX_HTML, maxDepth: 64, maxChildNodes: 2_000, ellipsis: '' },
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    ...['head', 'script', 'style', 'noscript', 'img', 'iframe', 'object', 'embed', 'svg', 'template',
      'video', 'audio', '[hidden]', '[aria-hidden="true"]']
      .map((selector) => ({ selector, format: 'skip' })),
  ],
});

export interface PersonalGmailConfig {
  mailbox: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  mailboxActions?: boolean;
}

interface GmailHeader {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
}

interface MessageBody {
  text: string;
  bodyStatus: 'plain_text' | 'unavailable';
}

export interface GmailReplyTarget {
  from: string;
  to: string;
  subject: string;
  threadId: string;
  inReplyTo: string;
  references: string[];
}

export type GmailDelivery =
  | { kind: 'accepted'; messageId: string }
  | { kind: 'rejected' | 'uncertain' };

interface AccessToken {
  value: string;
  expiresAt: number;
}

type JsonObject = Record<string, unknown>;

const unavailable = () => new Error('Personal Gmail is unavailable.');
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const gmailId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/u.test(value);
const opaqueValue = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length <= max && /^[\x21-\x7e]+$/u.test(value);
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u;
const localAtom = /[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+/iu.source;
const domainLabel = /[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/iu.source;
const mailboxSyntax = new RegExp('^' + localAtom + '(?:\\.' + localAtom + ')*@(?:' + domainLabel + '\\.)+' + domainLabel + '$', 'iu');
const messageId = (value: unknown): value is string =>
  typeof value === 'string' && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(value) && opaqueValue(value, 200);

function mailbox(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && value.indexOf('@') <= 64
    && mailboxSyntax.test(value) && /^[\x21-\x7e]+$/u.test(value);
}

function replyAddress(value: string | null | undefined): string | undefined {
  if (!value || value.length > 512 || controls.test(value)) return;
  if (mailbox(value)) return value;
  const nameAddress = /^(?:"(?:[^"\\]|\\.)*"|[^",:;<>]*)\s*<([^<>]+)>$/u.exec(value);
  if (mailbox(nameAddress?.[1])) return nameAddress[1];
}

function messageHeaders(payload: JsonObject): Map<string, string | null> {
  const headers = new Map<string, string | null>();
  for (const raw of values(payload.headers)) {
    const { name, value } = object(raw);
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    const key = name.toLowerCase();
    const normalized = value.replace(/\r\n[ \t]+/gu, ' ').trim();
    headers.set(key, headers.has(key) || controls.test(normalized) ? null : normalized);
  }
  return headers;
}

function canReadMessage(message: JsonObject, inboxOnly: boolean) {
  const labels = values(message.labelIds);
  return (!inboxOnly || labels.includes('INBOX')) &&
    !labels.some((label) => label === 'SPAM' || label === 'TRASH' || label === 'DRAFT');
}

function messageMetadata(message: JsonObject, id: string, headers: Map<string, string | null>, inboxOnly: boolean): GmailHeader {
  if (message.id !== id || !gmailId(message.threadId) || !canReadMessage(message, inboxOnly)) throw unavailable();
  return {
    id, threadId: message.threadId,
    from: (headers.get('from') ?? '').slice(0, 512),
    subject: (headers.get('subject') ?? '').slice(0, 512),
    date: (headers.get('date') ?? '').slice(0, 120),
    unread: values(message.labelIds).includes('UNREAD'),
  };
}

function replyTarget(from: string, threadId: string, headers: Map<string, string | null>): GmailReplyTarget | null {
  const to = replyAddress(headers.has('reply-to') ? headers.get('reply-to') : headers.get('from'));
  const subject = headers.get('subject') ?? '';
  const inReplyTo = headers.get('message-id');
  if (!to || !validSubject(subject) || !messageId(inReplyTo) || headers.get('references') === null) return null;
  const prior = (headers.get('references') ?? headers.get('in-reply-to'))?.split(/\s+/u) ?? [];
  if (!prior.every(messageId)) return null;
  return { from, to, subject, threadId, inReplyTo, references: [...prior.filter((id) => id !== inReplyTo).slice(-11), inReplyTo] };
}

function decodedBody(body: unknown, contentType: string | null | undefined, limit: number): string {
  const { data, attachmentId } = object(body);
  if (attachmentId !== undefined || typeof data !== 'string' || !/^[\w-]+={0,2}$/u.test(data)) return '';
  const charset = /(?:^|;)\s*charset\s*=\s*"?([\w-]+)/iu.exec(contentType ?? '')?.[1] ?? 'utf-8';
  const bytes = Buffer.from(data.slice(0, 4 * limit), 'base64url');
  try {
    return new TextDecoder(charset).decode(bytes).slice(0, limit);
  } catch {
    return new TextDecoder().decode(bytes).slice(0, limit);
  }
}

function readBodyText(payload: JsonObject): MessageBody {
  let pending = [payload];
  let html = '';
  for (let visited = 0; pending.length && visited < 100; visited++) {
    const [part, ...rest] = pending;
    pending = rest;
    const { mimeType, filename, body } = part;
    const headers = messageHeaders(part);
    const disposition = headers.get('content-disposition');
    if ((typeof filename === 'string' && filename !== '') || disposition === null ||
        (disposition !== undefined && !/^inline(?:\s*;|$)/iu.test(disposition))) continue;
    if (typeof mimeType === 'string' && /^multipart\//iu.test(mimeType)) {
      pending = [...values(part.parts).slice(0, 100).map(object), ...pending].slice(0, 100);
    } else if (mimeType === 'text/plain') {
      const text = decodedBody(body, headers.get('content-type'), MAX_TEXT);
      if (text.trim()) return { text, bodyStatus: 'plain_text' };
    } else if (mimeType === 'text/html' && !html) {
      html = decodedBody(body, headers.get('content-type'), MAX_HTML);
    }
  }
  const text = html ? htmlToText(html).slice(0, MAX_TEXT) : '';
  if (text.trim()) return { text, bodyStatus: 'plain_text' };
  return { text: '', bodyStatus: 'unavailable' };
}

async function boundedJson(response: Response, max: number): Promise<JsonObject> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      size += chunk.value.length;
      if (size > max) throw unavailable();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validSubject(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 240 && !controls.test(subject);
}

function subjectMime(subject: string): string {
  if (/^[\x20-\x7e]+$/u.test(subject)) return subject;
  // Each RFC 2047 encoded word fits a header line and ends at a UTF-8 character boundary.
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const char of subject) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 42) {
      words.push('=?UTF-8?B?' + Buffer.from(chunk).toString('base64') + '?=');
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  words.push('=?UTF-8?B?' + Buffer.from(chunk).toString('base64') + '?=');
  return words.join('\r\n ');
}

function replyMime(mailboxAddress: string, reply: GmailReplyTarget, body: string): string | undefined {
  if (!reply || reply.from !== mailboxAddress || !mailbox(reply.to) || !validSubject(reply.subject)
      || !gmailId(reply.threadId) || !messageId(reply.inReplyTo) || !Array.isArray(reply.references)
      || reply.references.length > 12 || !reply.references.every(messageId) || reply.references.at(-1) !== reply.inReplyTo
      || typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > 10_000
      || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(body)) return;
  const text = Buffer.from(body.replace(/\n/gu, '\r\n')).toString('base64').match(/.{1,76}/gu)?.join('\r\n');
  const mime = [
    'From: ' + mailboxAddress,
    'To: ' + reply.to,
    'Subject: ' + subjectMime(reply.subject),
    'In-Reply-To: ' + reply.inReplyTo,
    'References: ' + reply.references.join('\r\n '),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    text,
  ].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}

export class PersonalGmail {
  readonly #config: PersonalGmailConfig;
  readonly #http: typeof fetch;
  #token: AccessToken | undefined;
  #refreshing: Promise<AccessToken> | undefined;

  constructor(config: PersonalGmailConfig, http: typeof fetch = fetch) {
    if (!config || !mailbox(config.mailbox) || !opaqueValue(config.clientId)
        || !opaqueValue(config.clientSecret) || !opaqueValue(config.refreshToken)) throw unavailable();
    this.#config = { ...config };
    this.#http = http;
  }

  #request(url: string, options: RequestInit = {}) {
    return this.#http(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8_000) });
  }

  async #refresh(): Promise<AccessToken> {
    const { mailbox: expected, clientId, clientSecret, refreshToken } = this.#config;
    const startedAt = Date.now();
    const response = await this.#request(TOKEN, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
    });
    const { access_token, expires_in, token_type, scope } = await boundedJson(response, 16_384);
    if (!opaqueValue(access_token) || token_type !== 'Bearer' || typeof expires_in !== 'number'
        || !Number.isFinite(expires_in) || expires_in <= 0 || expires_in > 86_400) throw unavailable();
    if (scope !== undefined) {
      if (typeof scope !== 'string') throw unavailable();
      const granted = new Set(scope.split(/\s+/u));
      const expectedScopes = this.#config.mailboxActions ? new Set([FULL_MAILBOX_SCOPE]) : GMAIL_SCOPES;
      if (granted.size !== expectedScopes.size || [...granted].some((item) => !expectedScopes.has(item))) throw unavailable();
    }
    const profile = await this.#request(GMAIL + 'profile?fields=emailAddress', {
      headers: { authorization: 'Bearer ' + access_token },
    });
    const { emailAddress } = await boundedJson(profile, 4_096);
    if (!mailbox(emailAddress) || emailAddress.toLowerCase() !== expected.toLowerCase()) throw unavailable();
    const token = { value: access_token, expiresAt: startedAt + Math.max(0, expires_in - 30) * 1000 };
    this.#token = token;
    return token;
  }

  #getToken(): Promise<AccessToken> {
    if (this.#token && Date.now() < this.#token.expiresAt) return Promise.resolve(this.#token);
    return this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = undefined; });
  }

  #gmail(path: string, token: AccessToken, options: RequestInit = {}) {
    return this.#request(GMAIL + path, {
      ...options, headers: { authorization: 'Bearer ' + token.value, ...options.headers },
    }).then((response) => {
      if (response.status === 401 && this.#token === token) this.#token = undefined;
      return response;
    });
  }

  async #fullMessage(id: string, token: AccessToken) {
    return boundedJson(await this.#gmail('messages/' + id + '?format=FULL&fields=id,threadId,labelIds,payload', token), 1_048_576);
  }

  async list({ pageToken, unreadOnly }: { pageToken?: string; unreadOnly?: boolean } = {}): Promise<{ messages: GmailHeader[]; nextPageToken?: string }> {
    try {
      if (pageToken !== undefined && !opaqueValue(pageToken, 1024)) throw unavailable();
      const token = await this.#getToken();
      const search = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(PAGE_SIZE),
        fields: 'messages(id,threadId),nextPageToken' });
      if (unreadOnly) search.append('labelIds', 'UNREAD');
      if (pageToken) search.set('pageToken', pageToken);
      const listing = await boundedJson(await this.#gmail('messages?' + search, token), 8_192);
      const ids = values(listing.messages).map((entry) => object(entry).id);
      if (ids.length > PAGE_SIZE || !ids.every(gmailId) || new Set(ids).size !== ids.length ||
          (listing.nextPageToken !== undefined && !opaqueValue(listing.nextPageToken, 1024))) throw unavailable();
      const metadataQuery = 'format=METADATA&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date'
        + '&fields=id,threadId,labelIds,payload(headers)';
      const messages = [];
      for (let start = 0; start < ids.length; start += METADATA_CONCURRENCY) {
        messages.push(...await Promise.all(ids.slice(start, start + METADATA_CONCURRENCY).map(async (id) => {
          const message = await boundedJson(await this.#gmail('messages/' + id + '?' + metadataQuery, token), 32_768);
          return messageMetadata(message, id, messageHeaders(object(message.payload)), true);
        })));
      }
      return { messages: unreadOnly ? messages.filter(message => message.unread) : messages, ...(listing.nextPageToken ? { nextPageToken: listing.nextPageToken } : {}) };
    } catch {
      throw unavailable();
    }
  }

  async read(id: string): Promise<GmailHeader & MessageBody & { reply: GmailReplyTarget | null }> {
    try {
      if (!gmailId(id)) throw unavailable();
      const token = await this.#getToken();
      const message = await this.#fullMessage(id, token);
      const payload = object(message.payload);
      const headers = messageHeaders(payload);
      const metadata = messageMetadata(message, id, headers, true);
      const body = readBodyText(payload);
      const reply = body.bodyStatus === 'plain_text' ? replyTarget(this.#config.mailbox, metadata.threadId, headers) : null;
      return { ...metadata, ...body, reply };
    } catch {
      throw unavailable();
    }
  }

  async thread(id: string): Promise<{ threadId: string; messages: (GmailHeader & MessageBody)[] }> {
    try {
      if (!gmailId(id)) throw unavailable();
      const token = await this.#getToken();
      // Fetch only the ordered message IDs and labels before choosing which bodies to load.
      const thread = await boundedJson(
        await this.#gmail('threads/' + id + '?format=MINIMAL&fields=id,messages(id,labelIds)', token), 128_000,
      );
      const entries = values(thread.messages).map(object).filter((message) => canReadMessage(message, false));
      if (thread.id !== id || !entries.some((message) => canReadMessage(message, true))) throw unavailable();
      const ids = entries.map((message) => message.id);
      if (!ids.every(gmailId) || new Set(ids).size !== ids.length) throw unavailable();
      const messages = await Promise.all(ids.slice(-THREAD_SIZE).map(async (messageId) => {
        const message = await this.#fullMessage(messageId, token);
        if (message.threadId !== id) throw unavailable();
        const payload = object(message.payload);
        const metadata = messageMetadata(message, messageId, messageHeaders(payload), false);
        return { ...metadata, ...readBodyText(payload) };
      }));
      return { threadId: id, messages };
    } catch {
      throw unavailable();
    }
  }

  get mailboxActions() {
    return this.#config.mailboxActions === true;
  }

  async labels() {
    if (!this.mailboxActions) throw unavailable();
    const data = await boundedJson(await this.#gmail('labels?fields=labels(id,name,type)', await this.#getToken()), 512_000);
    return values(data.labels).flatMap(value => {
      const { id, name, type } = object(value);
      return type === 'user' && typeof id === 'string' && /^Label_[A-Za-z0-9_]{1,100}$/u.test(id)
        && typeof name === 'string' ? [{ id, name }] : [];
    });
  }

  async changeMessage(id: string, action: 'archive' | 'trash' | 'add_label' | 'remove_label' | 'delete',
    labelId: string | undefined, eligible: () => boolean): Promise<'changed' | 'unavailable' | 'unconfirmed'> {
    if (!this.mailboxActions || !gmailId(id) || !eligible()) return 'unavailable';
    let dispatched = false;
    try {
      const token = await this.#getToken();
      const path = 'messages/' + id;
      const labelAction = action === 'add_label' || action === 'remove_label';
      if (labelAction && (!labelId || !/^Label_[A-Za-z0-9_]{1,100}$/u.test(labelId))) return 'unavailable';
      const changes = action === 'archive' ? { removeLabelIds: ['INBOX'] }
        : action === 'add_label' ? { addLabelIds: [labelId] }
        : action === 'remove_label' ? { removeLabelIds: [labelId] } : undefined;
      if (!eligible()) return 'unavailable';
      dispatched = true;
      const response = await this.#gmail(action === 'delete' ? path : path + (action === 'trash' ? '/trash' : '/modify'), token, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        ...(changes && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes) }),
      });
      if (action === 'delete' && response.status === 204) return 'changed';
      if (response.ok && action !== 'delete') {
        return (await boundedJson(response, 32_768)).id === id ? 'changed' : 'unconfirmed';
      }
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 500 || response.ok ? 'unconfirmed' : 'unavailable';
    } catch {
      return dispatched ? 'unconfirmed' : 'unavailable';
    }
  }

  async send(reply: GmailReplyTarget, body: string, eligible: () => boolean): Promise<GmailDelivery> {
    let dispatched = false;
    try {
      // Serialize everything from the exact server-held approval before any await.
      const raw = replyMime(this.#config.mailbox, reply, body);
      if (!raw || !eligible()) return { kind: 'rejected' };
      const threadId = reply.threadId;
      const token = await this.#getToken();
      if (!eligible()) return { kind: 'rejected' };
      dispatched = true;
      const response = await this.#gmail('messages/send?fields=id,threadId', token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, threadId }),
      });
      if ([400, 401, 403, 404, 429].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'rejected' };
      }
      const receipt = await boundedJson(response, 8_192);
      if (gmailId(receipt.id) && receipt.threadId === threadId) return { kind: 'accepted', messageId: receipt.id };
    } catch {
      return { kind: dispatched ? 'uncertain' : 'rejected' };
    }
    return { kind: 'uncertain' };
  }
}
