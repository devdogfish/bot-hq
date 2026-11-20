import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { enqueue } from './agent/loop.js';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getOwnerSecretTarget } from './remote-agent.js';
import {
  callOwnerSecretEndpoint, currentSecureInputTarget, finishSecureInput, getSecureInput, ownerSecretList,
  ownerSecretRef, readSecureInputRef, SECURE_INPUT_BODY_LIMIT, secureInputDecision, serializeSecureInput,
} from './secure-input.js';
import { getBotRow } from './store.js';
import type { SecureInputResult } from './types.js';

export const secureInputApi = new Hono<AuthVars>();
const ownerOrigin = new URL(env.appUrl).origin;
const inFlight = new Set<string>();

const sameOrigin: MiddlewareHandler<AuthVars> = async (c, next) => {
  if (c.req.header('origin') !== ownerOrigin) return c.json({ error: 'Origin not allowed.' }, 403);
  await next();
};

for (const path of ['/secure-input/*', '/config/bots/:id/owner-secrets', '/config/bots/:id/owner-secrets/*']) {
  secureInputApi.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    return requireUser(c, next);
  });
}

secureInputApi.post('/secure-input/:request_id', sameOrigin, bodyLimit({
  maxSize: SECURE_INPUT_BODY_LIMIT,
  onError: (c) => c.json({ error: 'Secure input is too large.' }, 413),
}), async (c) => {
  const requestId = c.req.param('request_id');
  const userId = c.get('user').id;
  if (!getSecureInput(userId, requestId)) return c.json({ error: 'Secure input request not found.' }, 404);
  if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
    return c.json({ error: 'Use a JSON request.' }, 415);
  }
  const decision = secureInputDecision.safeParse(await c.req.json().catch(() => null));
  // Re-check generation and status after reading the body.
  const current = getSecureInput(userId, requestId);
  if (!current) return c.json({ error: 'Secure input request not found.' }, 404);
  if (!decision.success) return c.json({ error: 'Invalid secure input decision.' }, 400);
  const { request, card } = current;
  if (request.status === 'ready' && request.ref) return c.json({ status: 'ready', ref: request.ref });
  if (request.status === 'declined') return c.json({ status: 'declined' });
  if (inFlight.has(requestId)) return c.json({ error: 'Secure input is already being submitted.' }, 409);

  const complete = (result: SecureInputResult, oneTime?: boolean) => {
    finishSecureInput(request, card, result, oneTime);
    enqueue(request.bot_id, { type: 'secure-input' });
    return c.json(result);
  };
  if (decision.data.decision === 'decline') return complete({ status: 'declined' });

  const target = currentSecureInputTarget(request);
  if (!target) return c.json({ error: 'Agent connection changed. Ask the Agent for a new secure input request.' }, 409);
  const payload = serializeSecureInput(card, decision.data.fields, decision.data.one_time);
  if (!payload) return c.json({ error: 'Enter valid values for the requested fields.' }, 400);

  inFlight.add(requestId);
  try {
    const response = await callOwnerSecretEndpoint(target, '', 'POST', payload.body);
    const ref = await readSecureInputRef(response, card);
    if (ref) return complete({ status: 'ready', ref }, payload.oneTime);
  } catch { /* Never log or relay upstream bodies or errors. */ }
  finally { inFlight.delete(requestId); }
  return c.json({ error: 'Could not confirm storage with the Agent. Try submitting again.' }, 502);
});

secureInputApi.get('/config/bots/:id/owner-secrets', async (c) => {
  const bot = getBotRow(c.req.param('id'));
  if (!bot || bot.user_id !== c.get('user').id || bot.kind === 'room') return c.json({ error: 'not found' }, 404);
  const target = getOwnerSecretTarget(bot.id);
  if (!target) return c.json({ error: 'Set the owner-secret token in Agent connection.' }, 409);
  try {
    const response = await callOwnerSecretEndpoint(target, '', 'GET');
    if (response.ok) {
      const listing = ownerSecretList.safeParse(await response.json());
      if (listing.success) return c.json(listing.data);
    } else await response.body?.cancel();
  } catch { /* The upstream request or response failed. */ }
  return c.json({ error: 'Could not list shared items on the Agent.' }, 502);
});

secureInputApi.delete('/config/bots/:id/owner-secrets/:ref', sameOrigin, async (c) => {
  const bot = getBotRow(c.req.param('id'));
  if (!bot || bot.user_id !== c.get('user').id || bot.kind === 'room') return c.json({ error: 'not found' }, 404);
  const ref = ownerSecretRef.safeParse(c.req.param('ref'));
  if (!ref.success) return c.json({ error: 'Invalid shared item reference.' }, 400);
  const target = getOwnerSecretTarget(bot.id);
  if (!target) return c.json({ error: 'Set the owner-secret token in Agent connection.' }, 409);
  try {
    const response = await callOwnerSecretEndpoint(target, '/' + encodeURIComponent(ref.data), 'DELETE');
    if (response.status === 204) return c.body(null, 204);
    await response.body?.cancel();
  } catch { /* The upstream request failed. */ }
  return c.json({ error: 'Could not revoke the shared item on the Agent.' }, 502);
});
