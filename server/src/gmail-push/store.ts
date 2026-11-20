import type Database from 'better-sqlite3';

export function gmailPushStore(db: Database.Database, mailbox: string, botId: string) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_push_cursors (
      mailbox TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      history_id TEXT NOT NULL,
      PRIMARY KEY (mailbox, bot_id)
    );
    CREATE TABLE IF NOT EXISTS gmail_push_receipts (
      mailbox TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (mailbox, bot_id, message_id)
    );
  `);
  const scope = [mailbox.toLowerCase(), botId] as const;
  const cursor = db.prepare<[string, string], { history_id: string }>(
    'SELECT history_id FROM gmail_push_cursors WHERE mailbox = ? AND bot_id = ?',
  );
  const save = db.prepare(`
    INSERT INTO gmail_push_cursors (mailbox, bot_id, history_id) VALUES (?, ?, ?)
    ON CONFLICT (mailbox, bot_id) DO UPDATE SET history_id = excluded.history_id
    WHERE length(excluded.history_id) > length(history_id)
      OR (length(excluded.history_id) = length(history_id) AND excluded.history_id > history_id)
  `);
  const receipt = db.prepare('SELECT 1 FROM gmail_push_receipts WHERE mailbox = ? AND bot_id = ? AND message_id = ?');
  const record = db.prepare('INSERT OR IGNORE INTO gmail_push_receipts (mailbox, bot_id, message_id) VALUES (?, ?, ?)');
  const markDelivered = db.transaction((messageIds: string[]) => {
    for (const messageId of messageIds) record.run(...scope, messageId);
  });

  return {
    cursor: () => cursor.get(...scope)?.history_id,
    saveCursor: (id: string) => save.run(...scope, BigInt(id).toString()),
    delivered: (messageId: string) => !!receipt.get(...scope, messageId),
    markDelivered,
  };
}
