export const OWNER_EMAIL_TOOL = 'send_owner_email';

const RECIPIENT_COUNT = 3;
const LOCAL_ATOM = /[a-z0-9!#$%&'*+/=?^_`{|}~-]+/u.source;
const LOCAL_PART = new RegExp(String.raw`^${LOCAL_ATOM}(?:\.${LOCAL_ATOM})*$`, 'u');
const DOMAIN_LABEL = /[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/u.source;
const DOMAIN = new RegExp(String.raw`^(?:${DOMAIN_LABEL}\.)+${DOMAIN_LABEL}$`, 'u');
const EMAIL_ATOM = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]/u.source;
const EMAIL_ADDRESS = new RegExp(String.raw`(?<!${EMAIL_ATOM})${EMAIL_ATOM}+@[\p{L}\p{N}.-]+`, 'giu');
const POLITE_PREFIX = /^(?:(?:please\s+)?(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/iu;
const LEADING_SEND = /^(?:email\s+me|send\s+me\s+(?:an?\s+|the\s+)?email|send\s+(?:an?\s+|the\s+)?email\s+to\s+me)\b/iu;
const EXPLICIT_DRAFT = /^(?:draft|write|compose|prepare|preview|show\s+me)\b/iu;
const SEND_NEGATION = /\b(?:no\s+emails?|without\s+(?:actually\s+)?sending|draft\s+only|keep\s+(?:it|this)\s+(?:as\s+)?a\s+draft|not\s+asking\s+you\s+to\s+send|(?:no\s+need\s+to|do\s+not|don['’]t|should\s+not|shouldn['’]t|must\s+not|never|not\s+to)\s+(?:(?:you|ever|actually|immediately)\s+)?(?:send|email|mail|forward))\b/iu;
const RECIPIENT_HEADER = /^\s*(?:from|to|cc|bcc|sent)\s*:/imu;
const OTHER_RECIPIENT = /\b(?:cc|bcc)\b|\b(?:email|mail|forward|send)\s+(?:it|this|that)\s+to\s+(?!me\b|my\b)\S/iu;
const EXTRA_REQUEST = /[\r\n\u2028\u2029;]|[.!?]\s+\S|\b(?:then|and\s+(?:also\s+)?(?:send|email|mail|forward|ask|tell|notify|post|publish|share|text|message))\b/iu;
const CONDITIONAL_SEND = /\b(?:if|unless|when|once|after|before|tomorrow|later|wait|hold|not\s+now|next\s+\w+|every\s+\w+)\b/iu;
const RECIPIENT_SELECTION = /\b(?:only|just)\s+(?:(?:to|at|on|use)\s+)?(?:my|gmail|proton|pm\.me|one|two)\b|\b(?:to|at|via|on)\s+(?:(?:my|the)\s+)?(?:work|personal|gmail|proton|pm\.me|first|second|third)\b|\b(?:to|at|via|on)\s+(?:my|the)\s+(?:\w+\s+){0,3}(?:address|inbox|mailbox|account)\b|^(?:\+|(?:only\s+|just\s+)?(?:to|at|on|via|using|and|or)\s+)/iu;
const ALL_FIXED_RECIPIENTS = /^(?:to|at)\s+all\s+(?:three|3)\s+(?:(?:of\s+)?(?:the|my)\s+)?(?:(?:fixed|configured)\s+)?(?:email\s+)?addresses?[.!?]?$/iu;
const DIRECT_OTHER_RECIPIENT = /^(?:(?:email|mail)\s+(?!me\b|my\b|this\b|that\b|it\b)\S+(?:\s+(?:the|with|about|at)\b|[.!?]?$)|send\s+(?:an?\s+|the\s+)?email\s+to\s+(?!me\b|my\b)\S)/iu;

export function ownerEmailRecipients(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length !== RECIPIENT_COUNT) return undefined;
  const result = new Set<string>();
  for (const address of value) {
    if (typeof address !== 'string' || address.length > 254 ||
        /[\x00-\x20\x7f-\x9f\u2028\u2029]/u.test(address)) return undefined;
    const [local, domain, extra] = address.split('@');
    if (!domain || extra !== undefined || local.length > 64 ||
        !LOCAL_PART.test(local) || !DOMAIN.test(domain)) return undefined;
    result.add(address);
  }
  return result.size === RECIPIENT_COUNT ? [...result] : undefined;
}

export function classifyOwnerEmailRequest(text: string, recipients: readonly string[]): 'send' | 'review' | 'draft' {
  if (recipients.length !== RECIPIENT_COUNT) return 'draft';
  const fixedRecipients = new Set(recipients);
  if (fixedRecipients.size !== RECIPIENT_COUNT) return 'draft';
  const request = text.trim().replace(POLITE_PREFIX, '');
  if (!request || /^(?:["'`“‘>]|subject\s*:|[- ]{2,}(?:original|forwarded)\s+message)/iu.test(request) ||
      EXPLICIT_DRAFT.test(request) || SEND_NEGATION.test(request) ||
      RECIPIENT_HEADER.test(request) || OTHER_RECIPIENT.test(request)) {
    return 'draft';
  }

  const addresses = new Set<string>();
  for (const [match] of request.matchAll(EMAIL_ADDRESS)) {
    const address = match.replace(/\.+$/u, '').toLowerCase();
    if (!fixedRecipients.has(address)) return 'draft';
    addresses.add(address);
  }

  const send = LEADING_SEND.exec(request);
  if (!send) {
    if (addresses.size === 0 && DIRECT_OTHER_RECIPIENT.test(request)) return 'draft';
    return /\b(?:send|email|mail|forward)\b/iu.test(request) ? 'review' : 'draft';
  }
  const remainder = request.slice(send[0].length).trim();
  const explicitRecipient = addresses.size !== fixedRecipients.size
    && RECIPIENT_SELECTION.test(remainder) && !ALL_FIXED_RECIPIENTS.test(remainder);
  if ((addresses.size > 0 && addresses.size !== fixedRecipients.size) ||
      explicitRecipient || EXTRA_REQUEST.test(remainder) || CONDITIONAL_SEND.test(remainder) ||
      /^[!?.,]*\?$/u.test(remainder)) {
    return 'review';
  }
  return 'send';
}

export function ownerEmailContent(args: unknown): { subject: string; body: string } | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args) ||
      Reflect.ownKeys(args).length !== 2 || !Object.hasOwn(args, 'subject') || !Object.hasOwn(args, 'body')) {
    return null;
  }
  const { subject, body } = args as Record<string, unknown>;
  if (typeof subject !== 'string' || typeof body !== 'string' ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(subject) ||
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(body)) {
    return null;
  }
  const trimmedSubject = subject.trim();
  const trimmedBody = body.trim();
  if (!trimmedSubject || trimmedSubject.length > 200 || !trimmedBody || trimmedBody.length > 10_000) {
    return null;
  }
  return { subject: trimmedSubject, body: trimmedBody };
}

// Hermes supplies either the tool text directly or its single text content item.
export function ownerEmailProposalId(output: unknown): string | null {
  if (typeof output === 'string' && output.length > 500) return null;
  try {
    let value: any = typeof output === 'string' ? JSON.parse(output) : output;
    if (typeof value?.result === 'string') value = JSON.parse(value.result);
    const items = Array.isArray(value) ? value : value?.content;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length !== 1 || items[0]?.type !== 'text'
          || typeof items[0].text !== 'string' || value?.isError === true) return null;
      value = JSON.parse(items[0].text);
    }
    return value?.status === 'staged' && typeof value.proposalId === 'string'
      && /^mailprop_[\w-]{12}$/.test(value.proposalId) ? value.proposalId : null;
  } catch {
    return null;
  }
}
