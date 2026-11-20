import { Cron } from 'croner';
import { db, now } from './db.js';
import { appendRow } from './store.js';
import type { Routine } from './types.js';
import type { EnqueueTurn } from './agent/loop.js';
import { checkJobsMonitorHealth, isJobsMonitor } from './jobs-monitor.js';

const jobs = new Map<string, Cron>();
let enqueueFn: EnqueueTurn | null = null;
let botBusy: (botId: string) => boolean;

export function initRoutines(enqueue: EnqueueTurn, isBusy = (_botId: string) => false) {
  enqueueFn = enqueue;
  botBusy = isBusy;
  const all = db.prepare("SELECT * FROM routines WHERE enabled=1 AND schedule NOT LIKE 'event:%'").all() as any[];
  for (const r of all) scheduleRoutine({ id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone } as Routine);
  console.log(`[routines] scheduled ${jobs.size}`);
}

export function scheduleRoutine(r: Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule' | 'timezone'>) {
  if (r.schedule.startsWith('event:')) return;
  unscheduleRoutine(r.id);
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

export function runRoutine(id: string) {
  const r = db.prepare('SELECT * FROM routines WHERE id=?').get(id) as any;
  if (!r || !enqueueFn || r.schedule.startsWith('event:')) return;
  if (isJobsMonitor(r.bot_id, r.name)) {
    if (!r.enabled) return;
    checkJobsMonitorHealth(r.bot_id);
    if (botBusy(r.bot_id)) return;
  }
  if (!enqueueFn(r.bot_id, { type: 'routine', routineId: id, name: r.name, prompt: r.prompt })) return;
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), id);
  appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: `Running routine: ${r.name}`, ref: id });
}
