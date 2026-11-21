import { newId, sha256 } from '../lib/ids.js';
import { countBotsWithGateway, getBotRow } from '../store.js';
import { ownerEmailContent } from './owner-email-policy.js';
import { PersonalGmail, type GmailReplyTarget } from './personal-gmail.js';

export const PERSONAL_REPLY_TOOL = 'stage_personal_reply';
export const PERSONAL_DELETE_TOOL = 'stage_personal_delete';

export const PERSONAL_TOOLS = [
  {
    name: 'list_personal_gmail', description: 'List a page of the Owner’s personal inbox headers and unread flags.',
    fields: { pageToken: { type: 'string' }, unreadOnly: { type: 'boolean' } }, required: [],
  },
  {
    name: 'read_personal_gmail', description: 'Read one personal Gmail message by its ID.',
    fields: { messageId: { type: 'string' } }, required: ['messageId'],
  },
  {
    name: 'read_personal_gmail_thread', description: 'Read up to four recent messages in a personal Gmail thread after reading an inbox message from that thread.',
    fields: { threadId: { type: 'string' } }, required: ['threadId'],
  },
  {
    name: PERSONAL_REPLY_TOOL, description: 'Prepare a plain-text reply to a message you read in this turn. The Owner must approve the exact reply before it sends.',
    fields: { messageId: { type: 'string' }, body: { type: 'string' } }, required: ['messageId', 'body'],
  },
  {
    name: 'capture_personal_action', description: 'Add a clear Appointment or To-Do from a message you read in this turn. Ask when facts are ambiguous.',
    fields: {
      messageId: { type: 'string' },
      kind: { type: 'string', enum: ['todo', 'appointment'] },
      title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    }, required: ['messageId', 'kind', 'title'],
  },
  {
    name: 'list_personal_gmail_labels', description: 'List existing user-created labels in the Owner’s Gmail.',
    fields: {}, required: [],
  },
  {
    name: 'change_personal_gmail_message', description: 'Archive, trash, or change an existing label on a message you read in this turn when the Owner explicitly requests it.',
    fields: {
      messageId: { type: 'string' }, action: { type: 'string', enum: ['archive', 'trash', 'add_label', 'remove_label'] },
      labelId: { type: 'string' },
    }, required: ['messageId', 'action'],
  },
  {
    name: PERSONAL_DELETE_TOOL, description: 'Propose permanent deletion of one message you read in this turn. Requires the Owner’s separate approval.',
    fields: { messageId: { type: 'string' } }, required: ['messageId'],
  },
].map(({ name, description, fields, required }) => ({
  name, description, inputSchema: { type: 'object', properties: fields, required, additionalProperties: false },
}));

const mailboxTools = new Set([PERSONAL_DELETE_TOOL, 'list_personal_gmail_labels', 'change_personal_gmail_message']);

export function personalToolList() {
  const gmail = personalGmail();
  return gmail ? PERSONAL_TOOLS.filter(tool => gmail.mailboxActions || !mailboxTools.has(tool.name)) : [];
}

export function isPersonalAssistant(botId: string | null) {
  return !!botId && botId === process.env.HQ_PERSONAL_BOT_ID;
}

/**
 * James, the Personal Assistant, is his own Agent (Quantself ADR 0060). His record is ready when it
 * uses its own isolated gateway, belongs to the Owner who owns the business Agents, and is not one
 * of them. No other Bot may share his gateway.
 */
export function personalAssistantPaired(botId: string) {
  const targets = process.env.HQ_OWNER_EMAIL_TARGETS;
  if (!isPersonalAssistant(botId) || !targets) return false;
  try {
    const business = Object.values(JSON.parse(targets) ?? {}).filter((id): id is string => typeof id === 'string');
    const privateBot = getBotRow(botId);
    const origin = process.env.HQ_PERSONAL_GATEWAY_ORIGIN;
    if (!origin || !privateBot || privateBot.archived_at != null || privateBot.hermes_url !== origin ||
        business.includes(botId) || !business.some(id => getBotRow(id)?.user_id === privateBot.user_id)) return false;
    return countBotsWithGateway(origin) === 1;
  } catch {
    return false;
  }
}

export interface PersonalReply { target: GmailReplyTarget; body: string }

let cached: { config: string; transport: PersonalGmail } | undefined;

export function personalGmail() {
  const mailbox = process.env.HQ_PERSONAL_GMAIL_MAILBOX;
  const clientId = process.env.HQ_PERSONAL_GMAIL_CLIENT_ID;
  const clientSecret = process.env.HQ_PERSONAL_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.HQ_PERSONAL_GMAIL_REFRESH_TOKEN;
  if (!mailbox || !clientId || !clientSecret || !refreshToken) return undefined;
  const mailboxActions = process.env.HQ_PERSONAL_GMAIL_MAILBOX_ACTIONS === '1';
  const config = JSON.stringify([mailbox, clientId, clientSecret, refreshToken, mailboxActions]);
  try {
    if (cached?.config !== config) cached = { config, transport: new PersonalGmail({ mailbox, clientId, clientSecret, refreshToken, mailboxActions }) };
    return cached.transport;
  } catch {
    return undefined;
  }
}

export function newPersonalReadState(ownerText = '') {
  const command = ownerText.trim().replace(/^(?:(?:can|could|would) you +)?(?:please +)?/iu, '');
  const mailboxRequest = /^archive\b/iu.test(command) ? 'archive'
    : /^(?:trash\b|move\b[^\n]*\bto (?:the )?trash\b)/iu.test(command) ? 'trash'
    : /^(?:remove\b[^\n]*\blabel\b)/iu.test(command) ? 'remove_label'
    : /^(?:label\b|(?:apply|add)\b[^\n]*\blabel\b)/iu.test(command) ? 'add_label'
    : /^(?:permanently +)?delete\b/iu.test(command) ? 'delete'
    : undefined;
  return {
    mailboxRequest,
    messages: new Map<string, GmailReplyTarget | null>(),
    threads: new Set<string>(),
    labelIds: new Set<string>(),
    headers: new Map<string, { from: string; subject: string; date: string }>(),
    deletion: undefined as { proposalId: string; messageId: string; from: string; subject: string; date: string } | undefined,
    proposals: new Map<string, PersonalReply>(),
    stagingClosed: false,
    toolsClosed: false,
    inFlight: 0,
    readsRemaining: 20,
  };
}

export async function callPersonalTool(
  name: string,
  args: unknown,
  state: ReturnType<typeof newPersonalReadState>,
  current: () => boolean,
) {
  const denied = { status: 'unavailable' };
  if (!current() || state.toolsClosed || !args || typeof args !== 'object' || Array.isArray(args)) return denied;
  const fields = args as Record<string, unknown>;
  const gmail = personalGmail();
  if (!gmail) return denied;

  if (name === 'list_personal_gmail') {
    const { pageToken, unreadOnly } = fields;
    if (!state.readsRemaining || Object.keys(fields).some(key => !['pageToken', 'unreadOnly'].includes(key)) ||
        (unreadOnly !== undefined && typeof unreadOnly !== 'boolean') ||
        (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 1024))) return denied;
    state.readsRemaining--;
    const page = await gmail.list({ pageToken, unreadOnly });
    return current() ? page : denied;
  }

  if (name === 'read_personal_gmail_thread') {
    const { threadId } = fields;
    if (Object.keys(fields).length !== 1 || !state.readsRemaining ||
      typeof threadId !== 'string' || !state.threads.has(threadId)) return denied;
    state.readsRemaining--;
    const thread = await gmail.thread(threadId);
    return current() ? thread : denied;
  }

  if (name === 'list_personal_gmail_labels') {
    if (!gmail.mailboxActions || !state.readsRemaining || Object.keys(fields).length) return denied;
    state.readsRemaining--;
    const labels = await gmail.labels();
    if (!current()) return denied;
    state.labelIds = new Set(labels.map(label => label.id));
    return { labels };
  }

  const { messageId } = fields;
  if (typeof messageId !== 'string' || !/^[\w-]{1,128}$/.test(messageId)) return denied;
  if (name === 'read_personal_gmail') {
    if (Object.keys(fields).length !== 1 || !state.readsRemaining) return denied;
    state.readsRemaining--;
    const { reply, ...message } = await gmail.read(messageId);
    if (!current()) return denied;
    state.headers.set(messageId, { from: message.from, subject: message.subject, date: message.date });
    if (message.bodyStatus === 'plain_text') state.messages.set(messageId, reply);
    state.threads.add(message.threadId);
    return message;
  }
  if (name === 'change_personal_gmail_message') {
    const { action, labelId } = fields;
    const isLabel = action === 'add_label' || action === 'remove_label';
    if (!gmail.mailboxActions || action !== state.mailboxRequest || !state.headers.has(messageId) ||
        !(action === 'archive' || action === 'trash' || isLabel) ||
        (isLabel ? Object.keys(fields).length !== 3 || typeof labelId !== 'string' || !state.labelIds.has(labelId)
          : Object.keys(fields).length !== 2 || labelId !== undefined)) return denied;
    const status = await gmail.changeMessage(messageId, action, typeof labelId === 'string' ? labelId : undefined, current);
    if (status === 'changed' && !isLabel) state.headers.delete(messageId);
    return { status };
  }

  if (name === PERSONAL_DELETE_TOOL) {
    const header = state.headers.get(messageId);
    if (!gmail.mailboxActions || state.mailboxRequest !== 'delete' || !header || state.deletion || Object.keys(fields).length !== 1) return denied;
    const proposalId = newId('mailprop');
    state.deletion = { proposalId, messageId, ...header };
    return { status: 'staged', proposalId };
  }

  if (name === PERSONAL_REPLY_TOOL) {
    const target = state.messages.get(messageId);
    if (!target || state.stagingClosed || state.proposals.size >= 8 || Object.keys(fields).length !== 2) return denied;
    const content = ownerEmailContent({ subject: target.subject, body: fields.body });
    if (!content) return denied;
    const proposalId = newId('mailprop');
    state.proposals.set(proposalId, { target, body: content.body });
    return { status: 'staged', proposalId };
  }
  if (name === 'capture_personal_action' && state.messages.has(messageId)) {
    const { kind, title, start, end } = fields;
    if (typeof title !== 'string' || !title.trim() || title.length > 200) return denied;
    const normalizedTitle = title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
    if (kind === 'todo' && Object.keys(fields).length === 3) {
      const source = { messageId, actionKey: sha256(JSON.stringify([kind, normalizedTitle])) };
      return capturePersonalAction({ source, kind, title: title.trim().replace(/\s+/gu, ' ') }, current);
    }
    if (kind === 'appointment' && Object.keys(fields).length === 5 && typeof start === 'string' &&
      typeof end === 'string' && Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))) {
      const source = { messageId, actionKey: sha256(JSON.stringify([kind, Date.parse(start), Date.parse(end)])) };
      return capturePersonalAction({ source, kind, title: title.trim(), start, end }, current);
    }
  }
  return denied;
}

async function capturePersonalAction(input: object, current: () => boolean) {
  const origin = process.env.HQ_PERSONAL_QUANTSELF_ORIGIN;
  const key = process.env.HQ_PERSONAL_QUANTSELF_KEY;
  if (!origin || !key || !current()) return { status: 'unavailable' };
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) return { status: 'unavailable' };
  const response = await fetch(new URL('/api/v1/personal-assistant/captures', url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(input),
  });
  if (!response.ok) return { status: response.status === 409 ? 'review_required' : 'unavailable' };
  const { number, auditId, undone } = await response.json();
  if (!Number.isSafeInteger(number) || number < 1 || typeof auditId !== 'string' || !auditId ||
      typeof undone !== 'boolean') return { status: 'unconfirmed' };
  return { status: undone ? 'undone' : 'created', number, auditId, url: new URL(`/todo?task=${number}`, url).href };
}
