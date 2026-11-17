import { newId } from '../lib/ids.js';
import { getBotRow } from '../store.js';
import { ownerEmailRole } from './owner-email.js';
import { ownerEmailContent } from './owner-email-policy.js';
import { PersonalGmail, type GmailReplyTarget } from './personal-gmail.js';

export const PERSONAL_REPLY_TOOL = 'stage_personal_reply';

export const PERSONAL_TOOLS = [
  {
    name: 'list_personal_gmail', description: 'List a page of the Owner’s personal inbox headers.',
    fields: { pageToken: { type: 'string' } }, required: [],
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
    name: 'capture_personal_action', description: 'Add a clear Appointment or To-Do from a message you read in this turn. Use a stable action key for the action in that message. Ask when facts are ambiguous.',
    fields: {
      messageId: { type: 'string' }, actionKey: { type: 'string' },
      kind: { type: 'string', enum: ['todo', 'appointment'] },
      title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    }, required: ['messageId', 'actionKey', 'kind', 'title'],
  },
].map(({ name, description, fields, required }) => ({
  name, description, inputSchema: { type: 'object', properties: fields, required, additionalProperties: false },
}));

export function isPersonalAssistant(botId: string | null) {
  return !!botId && botId === process.env.HQ_TYLER_PERSONAL_BOT_ID;
}

export function personalAssistantPaired(botId: string) {
  const tylerId = process.env.HQ_OWNER_EMAIL_TARGETS;
  if (!isPersonalAssistant(botId) || !tylerId) return false;
  try {
    const tyler = JSON.parse(tylerId)?.tyler;
    const privateBot = getBotRow(botId);
    const origin = process.env.HQ_TYLER_PERSONAL_GATEWAY_ORIGIN;
    return typeof tyler === 'string' && tyler !== botId && !!origin && privateBot?.hermes_url === origin &&
      ownerEmailRole(tyler) === 'tyler' && getBotRow(tyler)?.user_id === privateBot.user_id &&
      getBotRow(tyler)?.hermes_url !== privateBot.hermes_url;
  } catch {
    return false;
  }
}

export interface PersonalReply { target: GmailReplyTarget; body: string }

let cached: { config: string; transport: PersonalGmail } | undefined;

export function personalGmail() {
  const mailbox = process.env.HQ_TYLER_GMAIL_MAILBOX;
  const clientId = process.env.HQ_TYLER_GMAIL_CLIENT_ID;
  const clientSecret = process.env.HQ_TYLER_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.HQ_TYLER_GMAIL_REFRESH_TOKEN;
  if (!mailbox || !clientId || !clientSecret || !refreshToken) return undefined;
  const config = JSON.stringify([mailbox, clientId, clientSecret, refreshToken]);
  try {
    if (cached?.config !== config) cached = { config, transport: new PersonalGmail({ mailbox, clientId, clientSecret, refreshToken }) };
    return cached.transport;
  } catch {
    return undefined;
  }
}

export function newPersonalReadState() {
  return {
    messages: new Map<string, GmailReplyTarget | null>(),
    threads: new Set<string>(),
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
    const { pageToken } = fields;
    if (!state.readsRemaining || Object.keys(fields).some((key) => key !== 'pageToken') ||
        (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 1024))) return denied;
    state.readsRemaining--;
    const page = await gmail.list({ pageToken });
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

  const { messageId } = fields;
  if (typeof messageId !== 'string' || !/^[\w-]{1,128}$/.test(messageId)) return denied;
  if (name === 'read_personal_gmail') {
    if (Object.keys(fields).length !== 1 || !state.readsRemaining) return denied;
    state.readsRemaining--;
    const { reply, ...message } = await gmail.read(messageId);
    if (!current()) return denied;
    if (message.bodyStatus === 'plain_text') state.messages.set(messageId, reply);
    state.threads.add(message.threadId);
    return message;
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
    const { actionKey, kind, title, start, end } = fields;
    if (typeof actionKey !== 'string' || !/^[\w-]{1,100}$/.test(actionKey) ||
      typeof title !== 'string' || !title.trim() || title.length > 200) return denied;
    const source = { messageId, actionKey };
    if (kind === 'todo' && Object.keys(fields).length === 4) {
      return capturePersonalAction({ source, kind, title: title.trim() }, current);
    }
    if (kind === 'appointment' && Object.keys(fields).length === 6 &&
      typeof start === 'string' && typeof end === 'string') {
      return capturePersonalAction({ source, kind, title: title.trim(), start, end }, current);
    }
  }
  return denied;
}

async function capturePersonalAction(input: object, current: () => boolean) {
  const origin = process.env.HQ_TYLER_QUANTSELF_ORIGIN;
  const key = process.env.HQ_TYLER_QUANTSELF_KEY;
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
