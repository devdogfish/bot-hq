import crypto from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { createSession, destroySession, isOwnerKey, requireUser, userFromCookieHeader, type AuthVars } from './lib/auth.js';
import { appendRow, clearConversation, emitBot, getBot, getBotRow, getLive, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { isApprovalChoice } from './agent/hermes-run.js';
import { enqueue, interrupt, isBotResetting, resetBotQueue, resolveApproval, setBotPaused } from './agent/loop.js';
import { computerState } from './computer.js';
import { assignEngine, draftEngineFor, provisionEngine, removeEngine, stopManagedEngine, syncPersona } from './engine.js';
import { deleteMemory, listMemories, memoryBot } from './engine-memory.js';
import { runRoutine, scheduleRoutine, setRoutineEnabled, syncBotRoutines, unscheduleRoutine } from './routines.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice/index.js';
import { defaultVoiceFor, isVoiceProviderId } from './voice/providers.js';
import type { AvatarColor, AvatarShape } from './types.js';
import { isSharingSecureInput } from './secure-input.js';

export const api = new Hono<AuthVars>();

const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

/** Thrown for things the user can fix; the message is shown to them. */
class UserError extends Error {}


function createBot(userId: string, b: { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string; mode?: string; isPrimary?: boolean }) {
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', b.isPrimary ? 1 : 0, now(), now());
  // The first bot is the agent that already runs on the computer; the others get an engine of their own.
  if (assignEngine(id) === 'managed') provisionEngine(id);
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

function findOrCreateUser(email: string, name?: string, preferId?: string) {
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email) as any;
  if (existing) return { id: existing.id as string, isNew: false };
  if (env.allowedEmails.length && !env.allowedEmails.includes(email.toLowerCase())) throw new UserError('This account is not allowed to sign in here.');
  const id = preferId ?? newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, name ?? email.split('@')[0], now());
  createBot(id, { name: env.primaryBotName, label: env.primaryBotLabel, description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
  return { id, isNew: true };
}

// ---------- auth ----------

api.get('/auth/me', (c) => {
  const user = userFromCookieHeader(c.req.header('cookie'));
  return c.json({ user, devLogin: env.devLogin });
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin) return c.json({ error: 'disabled' }, 403);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

/** One-time sign-in links made by the owner endpoint. Kept in memory: a restart drops them. */
const signInLinks = new Map<string, { userId: string; expires: number }>();

// Sign-in for whoever runs the server, without Google: the key only exists on the machine (see isOwnerKey).
// With `link`, it answers with a link that signs one browser in, once (scripts/sign-in-link.sh).
api.post('/auth/owner', async (c) => {
  if (!isOwnerKey((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''))) return c.json({ error: 'forbidden' }, 403);
  const { email, name, link } = await c.req.json<{ email: string; name?: string; link?: boolean }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    if (link) {
      const token = crypto.randomBytes(24).toString('base64url');
      signInLinks.set(token, { userId: id, expires: Date.now() + 15 * 60_000 });
      return c.json({ ok: true, url: `${env.appUrl}/api/auth/link/${token}` });
    }
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

api.get('/auth/link/:token', (c) => {
  const token = c.req.param('token');
  const l = signInLinks.get(token);
  signInLinks.delete(token);
  if (!l || l.expires < Date.now()) return c.text('This sign-in link was already used or has expired. Ask for a new one.', 410);
  createSession(c, l.userId);
  return c.redirect('/');
});

api.post('/auth/logout', (c) => { destroySession(c); return c.json({ ok: true }); });

// everything below requires a session
api.use('/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/health') return next();
  return requireUser(c, next);
});

// ---------- events (SSE) ----------

api.get('/events', (c) => {
  const user = c.get('user');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now() }) });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
  });
});

// ---------- bots ----------

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => {
  const bots = listBots(c.get('user').id);
  return c.json({ bots, live: bots.filter((bot) => bot.archivedAt === null).map((bot) => getLive(bot.id)) });
});

api.post('/bots', async (c) => {
  const body = await c.req.json();
  try {
    return c.json({ bot: createBot(c.get('user').id, body) });
  } catch (e: any) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

api.patch('/bots/:id', async (c) => {
  const p = await c.req.json();
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (p.voice_provider !== undefined && !isVoiceProviderId(p.voice_provider)) {
    return c.json({ error: 'Unknown voice provider' }, 400);
  }
  if (p.parentBotId !== undefined) {
    const parent = typeof p.parentBotId === 'string' ? ownBot(b.user_id, p.parentBotId) : null;
    if (p.parentBotId !== null && (!parent || parent.hidden)) return c.json({ error: 'Choose a Bot on your team.' }, 400);
    const cycle = parent && db.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT ?
        UNION
        SELECT b.parent_bot_id FROM bots b JOIN ancestors a ON a.id=b.id WHERE b.parent_bot_id IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE id=?
    `).get(parent.id, b.id);
    if (cycle) return c.json({ error: 'A Bot cannot be its own ancestor.' }, 400);
    db.prepare('UPDATE bots SET parent_bot_id=? WHERE id=?').run(p.parentBotId, b.id);
  }
  if (p.voice_provider !== undefined && p.voice_provider !== b.voice_provider) {
    db.prepare('UPDATE bots SET voice_provider=?, voice=?, updated_at=? WHERE id=?')
      .run(p.voice_provider, p.voice || defaultVoiceFor(p.voice_provider), now(), b.id);
    delete p.voice;
  }
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language' };
  for (const [k, col] of Object.entries(cols)) {
    if (p[k] !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof p[k] === 'boolean' ? (p[k] ? 1 : 0) : p[k], now(), b.id);
  }
  if (b.kind !== 'room') {
    if (['name', 'label', 'description'].some((k) => p[k] !== undefined)) syncPersona(b.id);
  }
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.patch('/bots/:id/archive', async (c) => {
  const body = await c.req.json<{ archived?: unknown }>().catch(() => null);
  const bot = ownBot(c.get('user').id, c.req.param('id'));
  if (!bot) return c.json({ error: 'not found' }, 404);
  if (typeof body?.archived !== 'boolean') return c.json({ error: 'archived must be a boolean' }, 400);
  if (isBotResetting(bot.id)) return c.json({ error: 'Bot maintenance is already in progress.' }, 409);
  if ((bot.archived_at != null) === body.archived) return c.json({ bot: getBot(bot.id) });
  if (body.archived) {
    if (isSharingSecureInput(bot.id)) return c.json({ error: 'Wait for the secure input submission to finish.' }, 409);
    db.prepare('UPDATE bots SET archived_at=?, pause_revision=pause_revision+1 WHERE id=?').run(now(), bot.id);
    syncBotRoutines(bot.id);
    await resetBotQueue(bot.id, () => stopManagedEngine(bot.id));
  } else {
    db.prepare('UPDATE bots SET archived_at=NULL WHERE id=?').run(bot.id);
    syncBotRoutines(bot.id);
    provisionEngine(bot.id);
  }
  emitBot(bot.id);
  hub.emit(bot.user_id, { type: 'routines', botId: bot.id });
  return c.json({ bot: getBot(bot.id) });
});

api.delete('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (isSharingSecureInput(b.id)) return c.json({ error: 'Wait for the secure input submission to finish.' }, 409);
  const deleted = await resetBotQueue(b.id, async () => {
    for (const r of listRoutines(b.id)) unscheduleRoutine(r.id);
    if (b.kind !== 'room') {
      await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
    }
    db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  });
  if (!deleted) return c.json({ error: 'Bot maintenance is already in progress.' }, 409);
  hub.emit(b.user_id, { type: 'computer', state: computerState(b.user_id) });
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.post('/bots/:id/messages', async (c) => {
  const { text, mode } = await c.req.json<{ text?: string; mode?: unknown }>();
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (isBotResetting(b.id)) return c.json({ error: 'Bot maintenance is already in progress.' }, 409);
  if (b.archived_at != null) return c.json({ error: 'This Bot is archived.' }, 409);
  if (b.paused) return c.json({ error: 'This bot is paused.' }, 409);
  if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'empty' }, 400);
  if (mode !== undefined && mode !== 'draft') return c.json({ error: 'Invalid message mode.' }, 400);
  const draftOnly = mode === 'draft';
  if (draftOnly && !draftEngineFor(b)) return c.json({ error: 'Draft only is unavailable for this bot.' }, 409);
  const input = text.trim();
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text: input, ...(draftOnly ? { draftOnly } : {}) });
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (b.kind === 'room') dispatchRoomMessage(b.id, input, enqueue);
  else enqueue(b.id, { type: 'user', text: input, chatRow: { generation: row.generation, seq: row.seq }, draftOnly });
  return c.json({ row });
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true });
});

api.patch('/bots/:id/pause', async (c) => {
  const body = await c.req.json<{ paused?: unknown }>().catch(() => null);
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || b.kind === 'room') return c.json({ error: 'not found' }, 404);
  if (typeof body?.paused !== 'boolean') return c.json({ error: 'paused must be a boolean' }, 400);
  setBotPaused(b.id, body.paused);
  return c.json({ paused: body.paused });
});

api.post('/bots/:id/fresh', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (isSharingSecureInput(b.id)) return c.json({ error: 'Wait for the secure input submission to finish.' }, 409);
  const cleared = await resetBotQueue(b.id, () => { clearConversation(b.id); });
  if (!cleared) return c.json({ error: 'Bot maintenance is already in progress.' }, 409);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const body = await c.req.json<{ decision?: unknown } | null>().catch(() => null);
  const decision = body?.decision === 'allow' ? 'once' : body?.decision;
  if (!isApprovalChoice(decision)) return c.json({ error: 'Invalid approval decision.' }, 400);
  const error = await resolveApproval(c.get('user').id, c.req.param('id'), decision);
  if (error) return c.json({ error }, error === 'not found' ? 404 : 409);
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const { answer } = await c.req.json<{ answer: string }>();
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (isBotResetting(b.id)) return c.json({ error: 'Bot maintenance is already in progress.' }, 409);
  if (b.paused) return c.json({ error: 'This bot is paused.' }, 409);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  updateRow(b.id, row.seq, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  if (row.body.card === 'secure-input') return c.json({ error: 'Use Decline on the secure input card.' }, 400);
  if (row.body.card === 'connect' && b.paused) return c.json({ error: 'This bot is paused.' }, 409);
  const body: any = { ...row.body, status: row.body.card === 'connect' ? 'skipped' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  const r = db.prepare('SELECT r.*, b.archived_at FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  if (r.archived_at != null) return c.json({ error: 'This Bot is archived.' }, 409);
  if (enabled && r.schedule.startsWith('event:')) return c.json({ error: 'App triggers are disabled.' }, 409);
  setRoutineEnabled(r.id, !!enabled);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.*, b.paused, b.archived_at FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  if (isBotResetting(r.bot_id)) return c.json({ error: 'Bot maintenance is already in progress.' }, 409);
  if (r.archived_at != null) return c.json({ error: 'This Bot is archived.' }, 409);
  if (r.paused) return c.json({ error: 'This bot is paused.' }, 409);
  if (r.schedule.startsWith('event:')) return c.json({ error: 'App triggers are disabled.' }, 409);
  runRoutine(r.id, true);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  return c.json({ tasks: rows.map((r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at })) });
});

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ memories: listMemories(b.id) });
});

api.delete('/memories/:id', (c) => {
  const botId = memoryBot(c.req.param('id'));
  if (!botId || !ownBot(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  deleteMemory(c.req.param('id'));
  return c.json({ ok: true });
});

api.get('/computer', (c) => c.json({ computer: computerState(c.get('user').id) }));

api.route('/voice', voiceApi);
