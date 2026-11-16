import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'loopback-test-only';
const { db } = await import('../server/dist/db.js');
const { enqueue, enqueueBotMessage, resetBotQueue } = await import('../server/dist/agent/loop.js');
const { initRooms, createRoom, dispatchRoomMessage } = await import('../server/dist/agent/rooms.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
const { initRoutines, runRoutine } = await import('../server/dist/routines.js');
const { listRows } = await import('../server/dist/store.js');

initRoutines(enqueue);
db.exec(`
  INSERT INTO users (id, email, name, created_at) VALUES ('team', 'test@example.test', 'Test', 0);
  INSERT INTO bots (id, user_id, name, created_at, updated_at)
  VALUES ('sender', 'team', 'Sender', 0, 0), ('target', 'team', 'Target', 0, 0);
  INSERT INTO routines (id, bot_id, name, prompt, schedule, created_at)
  VALUES ('routine', 'target', 'Scheduled work', 'Do something', '0 0 31 12 *', 0);
`);
initRooms();
const room = createRoom('team', 'Team', ['target']);

const target = 'target';
const attemptHandoff = () => toolMap.get('send_to_bot').impl(
  { bot_name: 'Target', message: 'Please help' },
  { botId: 'sender', userId: 'team', depth: 0, enqueueBotMessage },
);
const routineLastRun = () => db.prepare('SELECT last_run_at FROM routines WHERE id=?').get('routine').last_run_at;
const hold = Promise.withResolvers();
const reset = resetBotQueue(target, () => hold.promise);
try {
  const handoff = await attemptHandoff();
  assert.match(handoff.output, /undergoing maintenance.*try again/i);
  runRoutine('routine');
  assert.equal(routineLastRun(), null);
  assert.deepEqual(listRows(target), []);

  dispatchRoomMessage(room, 'Need a reply', enqueue);
  assert.match(listRows(room)[0].body.text, /Unavailable Bots: Target/);
} finally {
  hold.resolve();
  await reset;
}

const handoff = attemptHandoff();
runRoutine('routine');
await resetBotQueue(target, () => {});
assert.match((await handoff).output, /^Sent to Target/);
assert(listRows(target).some(({ body }) => body.from?.id === 'sender' && body.text === 'Please help'));
assert(listRows(target).some(({ body }) => body.event === 'routine-run'));
assert(routineLastRun() > 0);
console.log('Reset rejects handoffs and group dispatch visibly, and scheduled routines do not record a run until accepted.');
