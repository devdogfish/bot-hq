import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { enqueue, isBotResetting } from './agent/loop.js';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getOwnerSecretTarget } from './remote-agent.js';
import {
  callOwnerSecretEndpoint, currentSecureInputTarget, finishSecureInput, getSecureInput, ownerSecretList,
  ownerSecretRef, readSecureInputReceipt, SECURE_INPUT_BODY_LIMIT, secureInputDecision, serializeSecureInput,
  secureInputWrites, setSecureInputAttempt,
} from './secure-input.js';
import { getBotRow } from './store.js';
import type { SecureInputResult } from './types.js';

export const secureInputApi = new Hono<AuthVars>();
const ownerUrl = new URL(env.appUrl);
const ownerOrigin = ownerUrl.protocol === 'https:' || ownerUrl.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(ownerUrl.hostname) ? ownerUrl.origin : null;
const unconfirmed = 'The Agent may have stored this value. Retry with the same values and sharing settings, then revoke it if needed.';

const sameOrigin: MiddlewareHandler<AuthVars> = async (c, next) => {
  if (!ownerOrigin || c.req.header('origin') !== ownerOrigin) return c.json({ error: 'Origin not allowed.' }, 403);
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
  if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
    return c.json({ error: 'Use a JSON request.' }, 415);
  }
  const decision = secureInputDecision.safeParse(await c.req.json().catch(() => null));
  // Re-check generation and status after reading the body.
  const current = getSecureInput(userId, requestId);
  if (!current || isBotResetting(current.request.bot_id)) return c.json({ error: 'Secure input request not found.' }, 404);
  if (!decision.success) return c.json({ error: 'Invalid secure input decision.' }, 400);
  const { request, card } = current;
  if (request.status === 'ready') {
    if (!ownerSecretRef.safeParse(request.ref).success) return c.json({ error: 'The receipt is unavailable. Ask the Agent for a new request.' }, 409);
    return c.json({ status: 'ready', ref: request.ref });
  }
  if (request.status === 'declined') return c.json({ status: 'declined' });
  if (secureInputWrites.has(requestId)) return c.json({ error: 'Secure input is already being submitted.' }, 409);

  const complete = (result: SecureInputResult, oneTime?: boolean) => {
    finishSecureInput(request, card, result, oneTime);
    enqueue(request.bot_id, { type: 'secure-input' });
    return c.json(result);
  };
  if (decision.data.decision === 'decline') {
    if (request.submitted_one_time !== null) return c.json({ error: unconfirmed }, 409);
    return complete({ status: 'declined' });
  }

  const target = currentSecureInputTarget(request);
  if (!target) return c.json({ error: 'Agent connection changed. Ask the Agent for a new secure input request.' }, 409);
  const payload = serializeSecureInput(card, decision.data.fields, decision.data.one_time);
  if (!payload) return c.json({ error: 'Enter valid values for the requested fields.' }, 400);
  const firstAttempt = request.submitted_one_time === null;
  if (!firstAttempt && Number(payload.oneTime) !== request.submitted_one_time) {
    return c.json({ error: unconfirmed }, 409);
  }

  setSecureInputAttempt(requestId, payload.oneTime);
  secureInputWrites.set(requestId, request.bot_id);
  try {
    const response = await callOwnerSecretEndpoint(target, '', 'POST', payload.body);
    const rejected = [400, 401, 413].includes(response.status);
    const receipt = await readSecureInputReceipt(response, card, [...payload.values, target.token]);
    if (receipt) {
      if (receipt.expires_at && Date.parse(receipt.expires_at) <= Date.now()) {
        setSecureInputAttempt(requestId, null);
        return c.json({ error: 'This share expired. Ask the Agent for a new request.' }, 410);
      }
      return complete({ status: 'ready', ref: receipt.ref }, payload.oneTime);
    }
    if (firstAttempt && rejected) {
      setSecureInputAttempt(requestId, null);
      return c.json({ error: 'The Agent rejected this submission. Check the fields and Agent connection.' }, 422);
    }
  } catch { /* Never log or relay upstream bodies or errors. */ }
  finally { secureInputWrites.delete(requestId); }
  return c.json({ error: unconfirmed }, 502);
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
