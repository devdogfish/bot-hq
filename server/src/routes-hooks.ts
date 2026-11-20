import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { isPersonalAssistant } from './agent/personal-assistant.js';
import { env } from './env.js';
import { enqueueEvent, eventBody, maxEventBytes } from './events.js';

export const hooksApi = new Hono();

hooksApi.post('/:botId/:routine', async (c) => {
  const botId = c.req.param('botId');
  const given = /^Bearer +([a-f0-9]{64})$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (!given) return c.json({ error: 'unauthenticated' }, 401);
  const expected = createHmac('sha256', env.sessionSecret).update(`hook:${botId}`).digest();
  if (!timingSafeEqual(Buffer.from(given, 'hex'), expected)) return c.json({ error: 'unauthenticated' }, 401);

  if (isPersonalAssistant(botId)) return c.json({ error: 'Event routine not found.' }, 404);

  const tooLarge = () => c.json({ error: 'Event body exceeds 16 KiB.' }, 413);
  const invalid = () => c.json({ error: 'Expected event_id, summary and refs.' }, 400);
  if (Number(c.req.header('content-length')) > maxEventBytes) return tooLarge();
  const reader = c.req.raw.body?.getReader();
  if (!reader) return invalid();
  const bytes = new Uint8Array(maxEventBytes);
  let size = 0;
  let value: unknown;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > maxEventBytes) {
        void reader.cancel().catch(() => {});
        return tooLarge();
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    return invalid();
  } finally {
    reader.releaseLock();
  }
  const body = eventBody.safeParse(value);
  if (!body.success) return invalid();

  const result = enqueueEvent(botId, c.req.param('routine'), body.data);
  if (result === 'not_found') return c.json({ error: 'Event routine not found.' }, 404);
  if (result === 'unavailable') return c.json({ error: 'Bot is not accepting event turns.' }, 409);
  return c.json({ status: result }, result === 'accepted' ? 202 : 200);
});
