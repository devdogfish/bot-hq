import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { db } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { getOwnerSecretTarget } from './remote-agent.js';
import { appendRow, updateRow } from './store.js';
import type { SecureInputCard, SecureInputResult } from './types.js';

export const SECURE_INPUT_TOOL = 'request_secure_input';
export const SECURE_INPUT_KINDS = ['login', 'phone', 'code', 'text'] as const;
export const SECURE_INPUT_BODY_LIMIT = 64 * 1024;

const httpsOrigin = z.string().max(2048).transform((value, ctx) => {
  const url = URL.parse(value);
  if (url && url.port !== '0' && /^https:\/\/[^/?#@\\\s]+\/?$/i.test(value)) return url.origin;
  ctx.addIssue({ code: 'custom', message: 'Use an exact HTTPS origin.' });
  return z.NEVER;
});

const kind = z.enum(SECURE_INPUT_KINDS);
const label = z.string().trim().min(1).max(160).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u);
const requestArgs = z.strictObject({
  kind, site: httpsOrigin, label,
  reason: z.string().trim().min(1).max(1000),
  one_time: z.boolean(),
});

const value = z.string().min(1).max(SECURE_INPUT_BODY_LIMIT);
const fieldSchemas = {
  login: z.strictObject({ username: value, password: value, totp: value.optional() }),
  phone: z.strictObject({ phone: z.string().regex(/^\+[1-9]\d{1,14}$/) }),
  code: z.strictObject({ value }),
  text: z.strictObject({ value }),
};

export const secureInputDecision = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('decline') }),
  z.strictObject({ decision: z.literal('submit'), fields: z.unknown(), one_time: z.boolean().optional() }),
]);

export const ownerSecretRef = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/);
const readySchema = z.object({ ref: ownerSecretRef, kind, site: httpsOrigin });
export const ownerSecretList = z.array(z.object({
  ref: ownerSecretRef, kind, site: httpsOrigin, label, one_time: z.boolean(),
  expires_at: z.iso.datetime({ offset: true }).nullable(),
}));

interface RequestRow {
  request_id: string;
  bot_id: string;
  generation: number;
  row_seq: number;
  connection_id: string;
  status: SecureInputCard['status'];
  ref: string | null;
}

type Target = NonNullable<ReturnType<typeof getOwnerSecretTarget>>;

function connectionId(target: Target) {
  return createHmac('sha256', env.sessionSecret).update(target.baseUrl).update('\0').update(target.token).digest('hex');
}

export function stageSecureInput(botId: string, turnId: string, args: unknown):
  { error: string } | { request_id: string; status: 'pending' } {
  const parsed = requestArgs.safeParse(args);
  if (!parsed.success) return { error: 'Use a supported kind, an exact HTTPS origin, a label, a reason, and one_time.' };
  const target = getOwnerSecretTarget(botId);
  if (!target) return { error: 'Set up the owner-secret port and token in Agent connection.' };
  const { kind, site, label, reason, one_time } = parsed.data;
  if (kind === 'login' && one_time) return { error: 'Login sharing is persistent.' };
  const requestId = newId('sec');
  const card: SecureInputCard = {
    type: 'card', card: 'secure-input', requestId, kind, site, label, reason,
    oneTime: kind === 'phone' || kind === 'code' || one_time, status: 'pending',
  };
  db.transaction(() => {
    const row = appendRow(botId, 'card', card);
    db.prepare(`INSERT INTO secure_input_requests(request_id,bot_id,generation,row_seq,turn_id,connection_id)
      VALUES (?,?,?,?,?,?)`).run(requestId, botId, row.generation, row.seq, turnId, connectionId(target));
  })();
  return { request_id: requestId, status: 'pending' };
}

export function getSecureInput(userId: string, requestId: string) {
  const request = db.prepare(`
    SELECT r.*, s.body FROM secure_input_requests r
    JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
    JOIN rows s ON s.bot_id=r.bot_id AND s.generation=r.generation AND s.seq=r.row_seq
    WHERE r.request_id=? AND b.user_id=?
  `).get(requestId, userId) as (RequestRow & { body: string }) | undefined;
  if (!request) return null;
  const card = JSON.parse(request.body) as SecureInputCard;
  return { request, card };
}

export function currentSecureInputTarget(request: RequestRow) {
  const target = getOwnerSecretTarget(request.bot_id);
  return target && connectionId(target) === request.connection_id ? target : null;
}

export function finishSecureInput(request: RequestRow, card: SecureInputCard, result: SecureInputResult, oneTime = card.oneTime) {
  db.transaction(() => {
    db.prepare('UPDATE secure_input_requests SET status=?, ref=? WHERE request_id=?')
      .run(result.status, result.status === 'ready' ? result.ref : null, request.request_id);
    // A reset can complete while the Agent is storing the value. The new chat starts at seq 1.
    const active = db.prepare('SELECT 1 FROM bots WHERE id=? AND generation=?').get(request.bot_id, request.generation);
    if (active) {
      updateRow(request.bot_id, request.row_seq, { ...card, oneTime, status: result.status });
    }
  })();
}

export function secureInputNotices(botId: string, generation: number) {
  const target = getOwnerSecretTarget(botId);
  if (!target) return [];
  const rows = db.prepare(`
    SELECT request_id, status, ref FROM secure_input_requests
    WHERE bot_id=? AND generation=? AND connection_id=? AND notified=0 AND status<>'pending'
    ORDER BY row_seq
  `).all(botId, generation, connectionId(target)) as { request_id: string; status: SecureInputResult['status']; ref: string | null }[];
  return rows.map(({ request_id, status, ref }) => ({ request_id, status, ...(ref === null ? {} : { ref }) }));
}

export function markSecureInputNotified(requestIds: string[]) {
  const update = db.prepare('UPDATE secure_input_requests SET notified=1 WHERE request_id=?');
  db.transaction(() => {
    for (const id of requestIds) update.run(id);
  })();
}

export function callOwnerSecretEndpoint(target: Target, path: string, method: 'GET' | 'POST' | 'DELETE', body?: string) {
  return fetch(`${target.baseUrl}/v1/owner-secrets${path}`, {
    method, body,
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

export function serializeSecureInput(card: SecureInputCard, fields: unknown, requestedOneTime: boolean | undefined) {
  const parsed = fieldSchemas[card.kind].safeParse(fields);
  if (!parsed.success || (requestedOneTime !== undefined && card.kind !== 'phone')) return null;
  const oneTime = requestedOneTime ?? card.oneTime;
  const body = JSON.stringify({
    request_id: card.requestId, kind: card.kind, site: card.site, label: card.label,
    one_time: oneTime, fields: parsed.data,
  });
  return Buffer.byteLength(body) <= SECURE_INPUT_BODY_LIMIT ? { body, oneTime } : null;
}

export async function readSecureInputRef(response: Response, card: SecureInputCard) {
  if (response.status !== 201) {
    await response.body?.cancel();
    return null;
  }
  const parsed = readySchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.kind !== card.kind || parsed.data.site !== card.site) return null;
  return parsed.data.ref;
}
