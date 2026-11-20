import { z } from 'zod';
import { db, now } from './db.js';
import { appendRow, emitBot } from './store.js';

export const JOBS_MONITOR_TOOL = 'jobs_monitor_checkpoint';
export const JOBS_MONITOR_ROUTINE = 'Jobs inbox monitoring';
const MONITOR_STALE_MS = 12 * 60_000;
const PAGE_WINDOW = 128;
const cursor = z.number().int().min(0).max(4294967295);
const uid = z.number().int().min(1).max(4294967295);
const checkpoint = z.strictObject({ uidvalidity: uid.nullable(), after_uid: cursor });
const command = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('page'), checkpoint, uidvalidity: uid, after_uid: cursor, uids: z.array(uid).max(PAGE_WINDOW) }),
  z.strictObject({ kind: z.literal('failed'), checkpoint, reason: z.enum(['unavailable', 'stale_mailbox']) }),
  z.strictObject({ kind: z.literal('reset'), checkpoint, uidvalidity: uid }),
]);

type Status = z.infer<typeof checkpoint> & { checked_at: number; alert: string | null };

export function isJobsMonitor(botId: string, name: string) {
  return name === JOBS_MONITOR_ROUTINE && botId === process.env.HQ_JOBS_MONITOR_BOT_ID;
}

function enabled(botId: string | null) {
  if (!botId || !isJobsMonitor(botId, JOBS_MONITOR_ROUTINE)) return false;
  return db.prepare('SELECT id FROM routines WHERE bot_id=? AND name=? AND enabled=1 LIMIT 2')
    .all(botId, JOBS_MONITOR_ROUTINE).length === 1;
}

function state(botId: string, time: number): Status {
  db.prepare('INSERT OR IGNORE INTO jobs_monitor (bot_id,checked_at) VALUES (?,?)').run(botId, time);
  return db.prepare('SELECT uidvalidity,after_uid,checked_at,alert FROM jobs_monitor WHERE bot_id=?').get(botId) as Status;
}

function alert(botId: string, message: string) {
  db.prepare('UPDATE bots SET unread=unread+1 WHERE id=?').run(botId);
  appendRow(botId, 'message', { type: 'message', role: 'assistant', text: message });
}

function problem(botId: string, current: Status, reason: string, message: string) {
  if (current.alert !== null) return false;
  db.prepare('UPDATE jobs_monitor SET alert=? WHERE bot_id=?').run(reason, botId);
  alert(botId, message);
  return true;
}

export function checkJobsMonitorHealth(botId: string, time = now()) {
  if (!enabled(botId)) return;
  const posted = db.transaction(() => {
    const current = state(botId, time);
    return time - current.checked_at > MONITOR_STALE_MS && problem(botId, current, 'overdue',
      'Jobs inbox monitoring has not confirmed a check in over 12 minutes. The next successful check will resume from the last saved position.');
  })();
  if (posted) emitBot(botId);
}

export function jobsMonitorCommand(botId: string | null, args: unknown) {
  if (!botId || !enabled(botId)) return { status: 'disabled' };
  const parsed = command.safeParse(args);
  if (!parsed.success) return { status: 'invalid' };
  const input = parsed.data;
  const result = db.transaction(() => {
    const time = now();
    const current = state(botId, time);
    if (input.kind === 'read') {
      return { status: 'ok', checkpoint: { uidvalidity: current.uidvalidity, after_uid: current.after_uid } };
    }
    if (input.checkpoint.uidvalidity !== current.uidvalidity || input.checkpoint.after_uid !== current.after_uid) {
      return { status: 'conflict' };
    }
    if (input.kind === 'failed') {
      const posted = problem(botId, current, input.reason,
        'Jobs inbox monitoring could not confirm a check. It will retry from the last saved position.');
      return { status: 'ok', posted };
    }
    if (input.kind === 'reset') {
      if (current.uidvalidity === null || current.uidvalidity === input.uidvalidity) return { status: 'invalid' };
      db.prepare('UPDATE jobs_monitor SET uidvalidity=?, after_uid=0, alert=? WHERE bot_id=?')
        .run(input.uidvalidity, 'mailbox_reset', botId);
      alert(botId, 'The Jobs mailbox changed its message identifiers. Monitoring will rescan the inbox. Previously reported messages may reappear.');
      return { status: 'ok', posted: true };
    }
    if ((current.uidvalidity !== null && input.uidvalidity !== current.uidvalidity)
        || input.after_uid < current.after_uid || input.after_uid > current.after_uid + PAGE_WINDOW
        || input.uids.some((message, index) => message <= (input.uids[index - 1] ?? current.after_uid) || message > input.after_uid)) {
      return { status: 'invalid' };
    }
    db.prepare('UPDATE jobs_monitor SET uidvalidity=?,after_uid=?,checked_at=?,alert=NULL WHERE bot_id=?')
      .run(input.uidvalidity, input.after_uid, time, botId);
    if (input.uids.length) {
      alert(botId, `${input.uids.length} new Jobs inbox ${input.uids.length === 1 ? 'message' : 'messages'}. Mailbox ${input.uidvalidity}, message IDs ${input.uids.join(', ')}.`);
    }
    return { status: 'ok', posted: input.uids.length > 0 };
  })();
  if ('posted' in result) {
    if (result.posted) emitBot(botId);
    return { status: result.status };
  }
  return result;
}
