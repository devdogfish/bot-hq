import { Cron } from 'croner';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { appendRow } from './store.js';
import type { Routine } from './types.js';
import type { EnqueueTurn } from './agent/loop.js';
import { checkJobsMonitorHealth, isJobsMonitor } from './jobs-monitor.js';

const jobs = new Map<string, Cron>();
const FAILURE_LIMIT = 3;
let enqueueFn: EnqueueTurn | null = null;
let botBusy: (botId: string) => boolean;

export function initRoutines(enqueue: EnqueueTurn, isBusy = (_botId: string) => false) {
  enqueueFn = enqueue;
  botBusy = isBusy;
  const all = db.prepare("SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.enabled=1 AND b.archived_at IS NULL AND r.schedule NOT LIKE 'event:%'").all() as any[];
  for (const r of all) scheduleRoutine({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone } as Routine);
  console.log(`[routines] scheduled ${jobs.size}`);
}

export function validateRoutineSchedule(schedule: string, timezone: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone || 'UTC' }); } catch { throw new Error('Unknown timezone.'); }
  if (schedule.startsWith('event:')) {
    const name = schedule.slice('event:'.length);
    if (!name.trim()) throw new Error('Event name is required.');
    return;
  }
  new Cron(schedule, { timezone, paused: true });
}

export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  unscheduleRoutine(r.id);
  if (r.schedule.startsWith('event:')) return;
  try {
    const job = new Cron(r.schedule, { timezone: r.timezone || 'UTC', protect: true }, () => runRoutine(r.id));
    jobs.set(r.id, job);
    if (isJobsMonitor(r.botId, r.name)) checkJobsMonitorHealth(r.botId);
  } catch (e) {
    console.warn('[routines] bad schedule', r.id, r.schedule, (e as Error).message);
  }
}

export function unscheduleRoutine(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function setRoutineEnabled(id: string, enabled: boolean) {
  db.prepare(`UPDATE routines SET enabled=@enabled, run_revision=run_revision+1,
    consecutive_failures=CASE WHEN @enabled=1 THEN 0 ELSE consecutive_failures END
    WHERE id=@id AND enabled<>@enabled`).run({ id, enabled: Number(enabled) });
}

export function isRoutineRunCurrent(id: string, revision: number) {
  return !!db.prepare('SELECT 1 FROM routines WHERE id=? AND run_revision=?').get(id, revision);
}

export function recordRoutineResult(id: string, revision: number, userId: string, error?: string) {
  if (error === undefined) {
    db.prepare('UPDATE routines SET consecutive_failures=0 WHERE id=? AND run_revision=? AND consecutive_failures<>0')
      .run(id, revision);
    return;
  }

  const paused = db.transaction(() => {
    const routine = db.prepare(`UPDATE routines SET consecutive_failures=consecutive_failures+1
      WHERE id=? AND run_revision=? AND enabled=1 RETURNING consecutive_failures, bot_id, name`)
      .get(id, revision) as { consecutive_failures: number; bot_id: string; name: string } | undefined;
    if (!routine || routine.consecutive_failures < FAILURE_LIMIT) return;
    db.prepare('UPDATE routines SET enabled=0, run_revision=run_revision+1 WHERE id=?').run(id);
    const lastError = /[.!?]$/.test(error) ? error : `${error}.`;
    appendRow(routine.bot_id, 'notice', { type: 'notice', tone: 'warn',
      text: `Paused ${routine.name} after ${FAILURE_LIMIT} failed runs: ${lastError} Turn it back on in Manage.` });
    return routine;
  })();
  if (paused) {
    unscheduleRoutine(id);
    hub.emit(userId, { type: 'routines', botId: paused.bot_id });
  }
}

export function runRoutine(id: string, manual = false) {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.archived_at IS NULL').get(id) as any;
  if (!r || !enqueueFn || (!r.enabled && !manual) || r.schedule.startsWith('event:')) return;
  if (isJobsMonitor(r.bot_id, r.name)) {
    if (!r.enabled) return;
    checkJobsMonitorHealth(r.bot_id);
    if (botBusy(r.bot_id)) return;
  }
  if (!enqueueFn(r.bot_id, { type: 'routine', routineId: id, name: r.name, prompt: r.prompt, runRevision: r.run_revision })) return;
  recordRoutineRun(r.bot_id, id, r.name);
}

export function recordRoutineRun(botId: string, routineId: string, name: string) {
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), routineId);
  appendRow(botId, 'event', { type: 'event', event: 'routine-run', text: `Running routine: ${name}`, ref: routineId });
}

/** Reconcile this bot's timers after an archive change, preserving its routine preferences. */
export function syncBotRoutines(botId: string) {
  const routines = db.prepare('SELECT r.*, b.archived_at FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.bot_id=?').all(botId) as any[];
  for (const r of routines) {
    if (r.archived_at != null || !r.enabled || !enqueueFn) unscheduleRoutine(r.id);
    else scheduleRoutine({ id: r.id, botId, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone });
  }
}
