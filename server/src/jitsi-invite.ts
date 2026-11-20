import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { isPersonalAssistant } from './agent/personal-assistant.js';
import { enqueue, isBotResetting } from './agent/loop.js';
import { db } from './db.js';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow } from './store.js';

/**
 * Jitsi Meet's own "Add people" invite dialog, backed by the Owner's Agents.
 * Gate's config.js points `peopleSearchUrl` and `inviteServiceUrl` here and reads the bearer token
 * from `localStorage[peopleSearchTokenLocation]` on the Jitsi origin. An invite posts the room link
 * into the Agent's Bot HQ chat as the Owner, so the Agent joins with its meetings skill.
 */

interface InviteBot { id: string; name: string; label: string; generation: number }

const MAX_RESULTS = 10;
const inviteRequest = z.object({
  url: z.string().max(2048),
  invited: z.array(z.object({ id: z.string().max(128), type: z.string().max(32) }).loose()).min(1).max(20),
});

function tokenMac(userId: string) {
  return createHmac('sha256', env.sessionSecret).update(`jitsi-invite:${userId}`).digest();
}

/** `<userId>.<hex HMAC>`; rotating SESSION_SECRET revokes it. */
export function jitsiInviteToken(userId: string) {
  return `${userId}.${tokenMac(userId).toString('hex')}`;
}

function userFromBearer(header: string | undefined): string | null {
  const m = /^Bearer +([\w-]{1,64})\.([a-f0-9]{64})$/i.exec(header ?? '');
  if (!m) return null;
  const [, userId, mac] = m;
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), tokenMac(userId))) return null;
  return db.prepare('SELECT 1 FROM users WHERE id=?').get(userId) ? userId : null;
}

/** The meeting link, only on a configured Jitsi origin, without credentials or fragment. */
function meetingUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !env.jitsiOrigins.includes(url.origin)) return null;
  if (url.pathname.length < 2) return null;
  url.hash = '';
  return url.toString();
}

function invitableBots(userId: string): InviteBot[] {
  const rows = db.prepare(
    "SELECT id, name, label, generation FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 AND COALESCE(kind,'agent')<>'room' AND paused=0 AND archived_at IS NULL ORDER BY is_primary DESC, created_at ASC",
  ).all(userId) as InviteBot[];
  return rows.filter((bot) => !isPersonalAssistant(bot.id));
}

export const jitsiInviteApi = new Hono<AuthVars>();

// The Owner, signed in to Bot HQ, reads the token to store on the Jitsi origin once.
jitsiInviteApi.get('/token', requireUser, (c) => {
  c.header('Cache-Control', 'no-store');
  if (!env.jitsiOrigins.length) return c.json({ error: 'Jitsi invites are not configured.' }, 404);
  return c.json({ token: jitsiInviteToken(c.get('user').id), origins: env.jitsiOrigins });
});

jitsiInviteApi.use('/people', cors({ origin: (o) => (env.jitsiOrigins.includes(o) ? o : null), allowMethods: ['GET'], allowHeaders: ['Authorization'], maxAge: 600 }));
jitsiInviteApi.use('/invite', cors({ origin: (o) => (env.jitsiOrigins.includes(o) ? o : null), allowMethods: ['POST'], allowHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }));

jitsiInviteApi.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/token')) return next();
  if (!env.jitsiOrigins.length) return c.json({ error: 'not found' }, 404);
  const origin = c.req.header('origin');
  if (origin && !env.jitsiOrigins.includes(origin)) return c.json({ error: 'forbidden' }, 403);
  return next();
});

// Directory search for the invite dialog's autocomplete. Jitsi renders `name` and invites by `id`.
jitsiInviteApi.get('/people', (c) => {
  c.header('Cache-Control', 'no-store');
  const userId = userFromBearer(c.req.header('authorization'));
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  const query = (c.req.query('query') ?? '').trim().toLowerCase().slice(0, 64);
  const matches = invitableBots(userId)
    .filter((bot) => !query || bot.name.toLowerCase().includes(query) || bot.label.toLowerCase().includes(query))
    .slice(0, MAX_RESULTS)
    .map((bot) => ({ id: bot.id, type: 'user', name: bot.label ? `${bot.name} (${bot.label})` : bot.name }));
  return c.json(matches);
});

jitsiInviteApi.post('/invite', async (c) => {
  const userId = userFromBearer(c.req.header('authorization'));
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);
  const parsed = inviteRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Expected url and invited.' }, 400);
  const url = meetingUrl(parsed.data.url);
  if (!url) return c.json({ error: 'Meeting URL is not on a configured Jitsi origin.' }, 400);

  const bots = new Map(invitableBots(userId).map((bot) => [bot.id, bot]));
  const ids = [...new Set(parsed.data.invited.filter((i) => i.type === 'user').map((i) => i.id))];
  const unknown = ids.filter((id) => !bots.has(id) || isBotResetting(id));
  // Jitsi treats any non-2xx as a failed invite for the whole batch, so validate before sending any.
  if (!ids.length || unknown.length) return c.json({ error: 'Agent unavailable.', unavailable: unknown }, 409);

  const text = `Join this meeting: ${url}`;
  for (const id of ids) {
    const row = appendRow(id, 'message', { type: 'message', role: 'user', text });
    enqueue(id, { type: 'user', text, chatRow: { generation: row.generation, seq: row.seq } });
  }
  return c.json({ invited: ids });
});
