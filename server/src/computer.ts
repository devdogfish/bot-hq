import { db } from './db.js';
import type { ComputerState } from './types.js';

export function screenFor(userId: string, botId: string) {
  return db.prepare(`SELECT websockify_url AS url, vnc_password AS password, screen_revision AS revision
    FROM bots WHERE id=? AND user_id=? AND websockify_url IS NOT NULL`)
    .get(botId, userId) as { url: string; password: string; revision: number } | undefined;
}

export function computerState(userId: string): ComputerState {
  const screens = (db.prepare(`SELECT id, screen_revision AS revision FROM bots WHERE user_id=? AND websockify_url IS NOT NULL
    AND COALESCE(hidden,0)=0 ORDER BY created_at`).all(userId) as { id: string; revision: number }[])
    .map(({ id, revision }) => ({ botId: id, screenId: 'default', revision }));
  return { status: 'running', error: null, screens };
}
