import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { env } from './env.js';
import { enqueueEvent } from './events.js';

const eventBody = z.object({
  event_id: z.string().min(1),
  summary: z.string().min(1),
  refs: z.array(z.string()),
});

export const hooksApi = new Hono();

hooksApi.post('/:botId/:routine', async (c, next) => {
  const given = /^Bearer\s+([a-f0-9]{64})$/i.exec(c.req.header('authorization') ?? '')?.[1];
  const expected = createHmac('sha256', env.sessionSecret).update(`hook:${c.req.param('botId')}`).digest();
  if (!given || !timingSafeEqual(Buffer.from(given, 'hex'), expected)) return c.json({ error: 'unauthenticated' }, 401);
  await next();
}, bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: 'Event body exceeds 16 KB.' }, 413),
}), async (c) => {
  const body = eventBody.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) return c.json({ error: 'Expected event_id, summary and refs.' }, 400);

  const result = enqueueEvent(c.req.param('botId'), c.req.param('routine'), body.data);
  if (result === 'not_found') return c.json({ error: 'Event routine not found.' }, 404);
  if (result === 'unavailable') return c.json({ error: 'Bot is not accepting event turns.' }, 409);
  return c.json({ status: result }, result === 'accepted' ? 202 : 200);
});
