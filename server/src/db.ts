import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

if (env.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(env.dbPath), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(env.dbPath, 'a', 0o600));
  fs.chmodSync(env.dbPath, 0o600);
}
export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL DEFAULT 'blob',
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  mode TEXT NOT NULL DEFAULT 'personal',
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT 'medium',
  generation INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
CREATE TABLE IF NOT EXISTS agent_gateway_health (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  gateway_url TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_items (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation, idx)
);
CREATE TABLE IF NOT EXISTS pending_turns (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  row_seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS secure_input_requests (
  request_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  row_seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ref TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS secure_input_notifications
  ON secure_input_requests(bot_id, generation, connection_id) WHERE notified=0 AND status<>'pending';
CREATE TABLE IF NOT EXISTS owner_email_sends (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  owner_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, owner_seq)
);
CREATE INDEX IF NOT EXISTS owner_email_unresolved ON owner_email_sends(bot_id)
  WHERE status IN ('sending','uncertain');
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routines_event_schedule ON routines(bot_id, schedule)
  WHERE enabled=1;
CREATE TABLE IF NOT EXISTS seen_events (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  PRIMARY KEY (bot_id, event_id)
);
CREATE TABLE IF NOT EXISTS event_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL UNIQUE REFERENCES routines(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  pause_revision INTEGER NOT NULL,
  run_revision INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  event_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_batches_bot ON event_batches(bot_id);
CREATE TABLE IF NOT EXISTS pending_routine_events (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES event_batches(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_routine_events_batch ON pending_routine_events(batch_id);
CREATE TABLE IF NOT EXISTS jobs_monitor (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  uidvalidity INTEGER,
  after_uid INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  alert TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Idempotent column migrations for tables that predate a column.
function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('bots', 'voice', "TEXT NOT NULL DEFAULT 'luna'");
addColumn('bots', 'voice_speed', 'REAL NOT NULL DEFAULT 1');
addColumn('bots', 'voice_language', "TEXT NOT NULL DEFAULT 'auto'");
addColumn('bots', 'voice_provider', "TEXT NOT NULL DEFAULT 'xai'");
// Hermes engine: per-bot model choice, which engine runs the bot ('primary' = the existing agent,
// 'managed' = a gateway we start), and the managed gateway's port.
addColumn('bots', 'model', 'TEXT');
addColumn('bots', 'provider', 'TEXT');
// Model the Owner is trying in direct chat; production turns (routines, handoffs, rooms) keep model/provider.
addColumn('bots', 'chat_model', 'TEXT');
addColumn('bots', 'chat_provider', 'TEXT');
addColumn('bots', 'engine', 'TEXT');
addColumn('bots', 'engine_port', 'INTEGER');
addColumn('bots', 'handback_at', 'INTEGER');
addColumn('bots', 'hermes_url', 'TEXT');
addColumn('bots', 'hermes_key', 'TEXT');
addColumn('bots', 'gateway_revision', 'INTEGER NOT NULL DEFAULT 0');
// Discard the old outage and invalidate outstanding probes in the same configuration write.
db.exec(`
CREATE TRIGGER IF NOT EXISTS reset_agent_gateway_health
AFTER UPDATE OF hermes_url, engine, engine_port ON bots
WHEN NULLIF(OLD.hermes_url, '') IS NOT NULLIF(NEW.hermes_url, '')
  OR (NULLIF(NEW.hermes_url, '') IS NULL AND (OLD.engine IS NOT NEW.engine
    OR (NEW.engine = 'managed' AND OLD.engine_port IS NOT NEW.engine_port)))
BEGIN
  UPDATE bots SET gateway_revision = gateway_revision + 1 WHERE id = NEW.id;
  DELETE FROM agent_gateway_health WHERE bot_id = NEW.id;
END;
`);
addColumn('bots', 'websockify_url', 'TEXT');
addColumn('bots', 'vnc_password', 'TEXT');
addColumn('bots', 'cdp_port', 'INTEGER');
addColumn('bots', 'owner_secret_port', 'INTEGER NOT NULL DEFAULT 8655');
addColumn('bots', 'owner_secret_token', 'TEXT');
addColumn('bots', 'owner_secret_revision', 'INTEGER NOT NULL DEFAULT 0');
addColumn('secure_input_requests', 'submitted_one_time', 'INTEGER');
addColumn('bots', 'screen_revision', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'paused', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'pause_revision', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bots', 'kind', "TEXT NOT NULL DEFAULT 'agent'");
addColumn('bots', 'parent_bot_id', 'TEXT REFERENCES bots(id) ON DELETE SET NULL');
addColumn('bots', 'archived_at', 'INTEGER');
addColumn('routines', 'consecutive_failures', 'INTEGER NOT NULL DEFAULT 0');
addColumn('routines', 'run_revision', 'INTEGER NOT NULL DEFAULT 0');

export const now = () => Date.now();
